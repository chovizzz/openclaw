import { normalizeLowercaseStringOrEmpty } from "../string-coerce.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE = /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "tool_calls",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;

function endsInsideQuotedString(text: string, start: number, end: number): boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < end; idx += 1) {
    const char = text[idx];
    if (quoteChar === null) {
      if (char === '"' || char === "'") {
        quoteChar = char;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === quoteChar) {
      quoteChar = null;
    }
  }

  return quoteChar !== null;
}

interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

function isToolCallBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || char === "/" || char === ">";
}

function findTagCloseIndex(text: string, start: number): number {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < text.length; idx += 1) {
    const char = text[idx];
    if (quoteChar !== null) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (char === "<") {
      return -1;
    }
    if (char === ">") {
      return idx;
    }
  }

  return -1;
}

function looksLikeToolCallPayloadStart(text: string, start: number): boolean {
  return TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(start));
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  if (text[start] !== "<") {
    return null;
  }

  let cursor = start + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  let isClose = false;
  if (text[cursor] === "/") {
    isClose = true;
    cursor += 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  while (cursor < text.length && /[A-Za-z_]/.test(text[cursor])) {
    cursor += 1;
  }

  const tagName = normalizeLowercaseStringOrEmpty(text.slice(nameStart, cursor));
  if (!TOOL_CALL_TAG_NAMES.has(tagName) || !isToolCallBoundary(text[cursor])) {
    return null;
  }
  const contentStart = cursor;

  const closeIndex = findTagCloseIndex(text, cursor);
  if (closeIndex === -1) {
    return {
      contentStart,
      end: text.length,
      isClose,
      isSelfClosing: false,
      tagName,
      isTruncated: true,
    };
  }

  return {
    contentStart,
    end: closeIndex + 1,
    isClose,
    isSelfClosing: !isClose && /\/\s*$/.test(text.slice(cursor, closeIndex)),
    tagName,
    isTruncated: false,
  };
}

const PLURAL_TOOL_CALL_WRAPPER_TAGS = new Set(["function_calls", "tool_calls"]);

/** Index of the close tag that balances an opening tool-call tag, or -1. */
function findMatchingToolCallCloseIndex(text: string, start: number, tagName: string): number {
  let depth = 1;
  for (let idx = start; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    const tag = parseToolCallTagAt(text, idx);
    if (!tag || tag.tagName !== tagName || tag.isTruncated) {
      continue;
    }
    if (tag.isSelfClosing) {
      idx = Math.max(idx, tag.end - 1);
      continue;
    }
    depth += tag.isClose ? -1 : 1;
    if (depth === 0) {
      return idx;
    }
    idx = Math.max(idx, tag.end - 1);
  }
  return -1;
}

const FUNCTION_RESPONSE_CLOSE_TAG = "</function_response>";
const FUNCTION_RESPONSE_OPEN_RE = /^\s*<function_response(?:\s[^>]*)?>/i;
const FUNCTION_RESPONSE_OPEN_TAG_RE = /<function_response(?:\s[^>]*)?>/gi;

/**
 * Depth-aware close finder. A plain `indexOf` returns the *first* literal
 * `</function_response>`, so a response body that legitimately quotes that
 * string would end the strip early and delete the real prose that follows it.
 */
function findFunctionResponseCloseIndex(text: string, from: number): number {
  let depth = 1;
  let cursor = from;
  while (cursor < text.length) {
    const close = text.indexOf(FUNCTION_RESPONSE_CLOSE_TAG, cursor);
    if (close === -1) {
      return -1;
    }
    FUNCTION_RESPONSE_OPEN_TAG_RE.lastIndex = cursor;
    let nested = 0;
    let match: RegExpExecArray | null;
    while ((match = FUNCTION_RESPONSE_OPEN_TAG_RE.exec(text)) !== null && match.index < close) {
      nested++;
    }
    depth += nested - 1;
    if (depth === 0) {
      return close;
    }
    cursor = close + FUNCTION_RESPONSE_CLOSE_TAG.length;
  }
  return -1;
}

/**
 * End offset of a leaked `<function_calls>...</function_calls><function_response>...
 * </function_response>` pair starting at `tag`, or -1 when this is not that shape.
 *
 * A bare plural wrapper is left alone: models legitimately quote it as a prose
 * example. It is only treated as a leak when a `function_response` block follows
 * immediately, which no prose example does.
 *
 * `function_response` is deliberately NOT added to TOOL_CALL_TAG_NAMES (that would
 * change unrelated stripping behavior), so it is matched with literal scans here.
 * Both scans are `indexOf`/anchored-prefix only, so this stays linear per wrapper.
 */
function findPluralToolCallResponseLeakEnd(text: string, tag: ParsedToolCallTag): number {
  if (!PLURAL_TOOL_CALL_WRAPPER_TAGS.has(tag.tagName) || tag.isTruncated) {
    return -1;
  }
  const wrapperCloseStart = findMatchingToolCallCloseIndex(text, tag.end, tag.tagName);
  if (wrapperCloseStart === -1) {
    return -1;
  }
  const wrapperCloseTag = parseToolCallTagAt(text, wrapperCloseStart);
  if (!wrapperCloseTag) {
    return -1;
  }
  const afterWrapper = text.slice(wrapperCloseTag.end);
  const openMatch = FUNCTION_RESPONSE_OPEN_RE.exec(afterWrapper);
  if (!openMatch) {
    return -1;
  }
  const responseBodyStart = wrapperCloseTag.end + openMatch[0].length;
  const responseCloseStart = findFunctionResponseCloseIndex(text, responseBodyStart);
  if (responseCloseStart === -1) {
    return -1;
  }
  return responseCloseStart + FUNCTION_RESPONSE_CLOSE_TAG.length;
}

export function stripToolCallXmlTags(
  text: string,
  options: { stripFunctionResponseAfterPluralToolCalls?: boolean } = {},
): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const hasFunctionResponse =
    options.stripFunctionResponseAfterPluralToolCalls === true &&
    text.includes(FUNCTION_RESPONSE_CLOSE_TAG);
  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallContentStart = 0;
  let toolCallBlockTagName: string | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    if (!inToolCallBlock && isInsideCode(idx, codeRegions)) {
      continue;
    }

    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }

    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (tag.isClose) {
        if (tag.isTruncated) {
          const preserveEnd = tag.contentStart;
          result += text.slice(idx, preserveEnd);
          lastIndex = preserveEnd;
          idx = Math.max(idx, preserveEnd - 1);
          continue;
        }
        const balance = visibleTagBalance.get(tag.tagName) ?? 0;
        if (balance > 0) {
          result += text.slice(idx, tag.end);
          visibleTagBalance.set(tag.tagName, balance - 1);
        }
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (tag.isSelfClosing) {
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (options.stripFunctionResponseAfterPluralToolCalls === true && hasFunctionResponse) {
        const leakEnd = findPluralToolCallResponseLeakEnd(text, tag);
        if (leakEnd !== -1) {
          lastIndex = leakEnd;
          idx = Math.max(idx, leakEnd - 1);
          continue;
        }
      }
      if (
        !tag.isClose &&
        looksLikeToolCallPayloadStart(text, tag.isTruncated ? tag.contentStart : tag.end)
      ) {
        inToolCallBlock = true;
        toolCallContentStart = tag.end;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
      } else {
        const preserveEnd = tag.isTruncated ? tag.contentStart : tag.end;
        result += text.slice(idx, preserveEnd);
        if (!tag.isTruncated) {
          visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
        }
        lastIndex = preserveEnd;
        idx = Math.max(idx, preserveEnd - 1);
        continue;
      }
    } else if (
      tag.isClose &&
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      !endsInsideQuotedString(text, toolCallContentStart, idx)
    ) {
      inToolCallBlock = false;
      toolCallBlockTagName = null;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return text;
  }

  // Remove <invoke ...>...</invoke> blocks (non-greedy to handle multiple).
  let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");

  // Remove stray minimax tool tags.
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");

  return cleaned;
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text) {
    return text;
  }
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
        index += 1;
        continue;
      }
      break;
    }
    if (index >= input.length) {
      return null;
    }

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let idx = index; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            return idx + 1;
          }
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let idx = index + 1; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          return idx + 1;
        }
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") {
      end += 1;
    }
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const toolCallRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(toolCallRe)) {
      const start = match.index ?? 0;
      if (start < cursor) {
        continue;
      }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") {
          index += 1;
        }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
        index += 9;
        if (input[index] === ":") {
          index += 1;
        }
        if (input[index] === " ") {
          index += 1;
        }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) {
          index = end;
        }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") {
          index += 1;
        }
        if (input[index] === "\n") {
          index += 1;
        }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  // Remove [Tool Call: name (ID: ...)] blocks and their Arguments.
  let cleaned = stripToolCalls(text);

  // Remove [Tool Result for ID ...] blocks and their content.
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");

  // Remove [Historical context: ...] markers (self-contained within brackets).
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
}

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

export type AssistantVisibleTextSanitizerProfile = "delivery" | "history" | "internal-scaffolding";

type AssistantVisibleTextPipelineOptions = {
  finalTrim: ReasoningTagTrim;
  preserveDowngradedToolText?: boolean;
  preserveMinimaxToolXml?: boolean;
  stripFunctionResponseAfterPluralToolCalls?: boolean;
  reasoningMode: ReasoningTagMode;
  reasoningTrim: ReasoningTagTrim;
  stageOrder: "reasoning-first" | "reasoning-last";
};

const ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS: Record<
  AssistantVisibleTextSanitizerProfile,
  AssistantVisibleTextPipelineOptions
> = {
  delivery: {
    finalTrim: "both",
    stripFunctionResponseAfterPluralToolCalls: true,
    reasoningMode: "strict",
    reasoningTrim: "both",
    stageOrder: "reasoning-last",
  },
  history: {
    finalTrim: "none",
    reasoningMode: "strict",
    reasoningTrim: "none",
    stageOrder: "reasoning-last",
  },
  "internal-scaffolding": {
    finalTrim: "start",
    preserveDowngradedToolText: true,
    preserveMinimaxToolXml: true,
    reasoningMode: "preserve",
    reasoningTrim: "start",
    stageOrder: "reasoning-first",
  },
};

function applyAssistantVisibleTextStagePipeline(
  text: string,
  options: AssistantVisibleTextPipelineOptions,
): string {
  if (!text) {
    return text;
  }

  const stripReasoning = (value: string) =>
    stripReasoningTagsFromText(value, {
      mode: options.reasoningMode,
      trim: options.reasoningTrim,
    });
  const applyFinalTrim = (value: string) => {
    if (options.finalTrim === "none") {
      return value;
    }
    if (options.finalTrim === "start") {
      return value.trimStart();
    }
    return value.trim();
  };
  const stripNonReasoningStages = (value: string) => {
    let cleaned = value;
    if (!options.preserveMinimaxToolXml) {
      cleaned = stripMinimaxToolCallXml(cleaned);
    }
    cleaned = stripModelSpecialTokens(cleaned);
    cleaned = stripRelevantMemoriesTags(cleaned);
    cleaned = stripToolCallXmlTags(cleaned, {
      stripFunctionResponseAfterPluralToolCalls: options.stripFunctionResponseAfterPluralToolCalls,
    });
    if (!options.preserveDowngradedToolText) {
      cleaned = stripDowngradedToolCallText(cleaned);
    }
    return cleaned;
  };

  if (options.stageOrder === "reasoning-first") {
    return applyFinalTrim(stripNonReasoningStages(stripReasoning(text)));
  }

  return applyFinalTrim(stripReasoning(stripNonReasoningStages(text)));
}

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
): string {
  return applyAssistantVisibleTextStagePipeline(
    text,
    ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS[profile],
  );
}

export function stripAssistantInternalScaffolding(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "internal-scaffolding");
}

/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export function sanitizeAssistantVisibleText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}

/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
export function sanitizeAssistantVisibleTextWithOptions(
  text: string,
  options?: { trim?: "none" | "both" },
): string {
  const profile = options?.trim === "none" ? "history" : "delivery";
  return sanitizeAssistantVisibleTextWithProfile(text, profile);
}
