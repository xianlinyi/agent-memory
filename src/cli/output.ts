import type { ParsedArgs } from "./args.js";

const SPINNER_FRAMES = [
  "\x1b[34m⠋\x1b[0m",
  "\x1b[34m⠙\x1b[0m",
  "\x1b[34m⠹\x1b[0m",
  "\x1b[34m⠸\x1b[0m",
  "\x1b[34m⠼\x1b[0m",
  "\x1b[34m⠴\x1b[0m",
  "\x1b[34m⠦\x1b[0m",
  "\x1b[34m⠧\x1b[0m",
  "\x1b[34m⠇\x1b[0m",
  "\x1b[34m⠏\x1b[0m"
];
const NO_COLOR_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface CliSpinner {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function printJsonOrText(parsed: ParsedArgs, value: unknown, text?: string): void {
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(text ?? JSON.stringify(value, null, 2));
  }
}

export async function withSpinner<T>(parsed: ParsedArgs, message: string, operation: () => Promise<T>): Promise<T> {
  return createSpinner(parsed, message).run(operation);
}

export function createSpinner(parsed: ParsedArgs, initialMessage: string): CliSpinner {
  const enabled = Boolean(process.stderr.isTTY) && !parsed.flags.has("verbose");
  const frames = process.env.NO_COLOR ? NO_COLOR_SPINNER_FRAMES : SPINNER_FRAMES;
  let frameIndex = 0;
  let timer: NodeJS.Timeout | undefined;
  let lastLength = 0;
  let cursorHidden = false;
  const startedAt = Date.now();

  const render = () => {
    if (!enabled) return;
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const elapsedText = process.env.NO_COLOR ? `${elapsedSeconds}s` : `\x1b[90m${elapsedSeconds}s\x1b[0m`;
    const line = `${frames[frameIndex]} ${initialMessage} ${elapsedText}`;
    frameIndex = (frameIndex + 1) % frames.length;
    lastLength = Math.max(lastLength, line.length);
    process.stderr.write(`\r${line}${" ".repeat(Math.max(0, lastLength - line.length))}`);
  };

  const stop = () => {
    if (!enabled) return;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    process.stderr.write(`\r${" ".repeat(lastLength)}\r`);
    if (cursorHidden) {
      process.stderr.write("\x1b[?25h");
      cursorHidden = false;
    }
    lastLength = 0;
  };

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (enabled) {
        process.stderr.write("\x1b[?25l");
        cursorHidden = true;
        render();
        timer = setInterval(render, 80);
      }
      try {
        return await operation();
      } finally {
        stop();
      }
    }
  };
}
