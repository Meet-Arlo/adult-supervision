export type Style = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  /** Status badge colors: inverse text keeps the badge readable on light and dark themes. */
  badge: (s: string, color: 'red' | 'green' | 'yellow' | 'cyan') => string;
};

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36 } as const;

function wrap(enabled: boolean, open: number, close: number): (s: string) => string {
  return enabled ? (s) => `\u001b[${open}m${s}\u001b[${close}m` : (s) => s;
}

export function createStyle(enabled: boolean): Style {
  const colors = {
    red: wrap(enabled, CODES.red, 39),
    green: wrap(enabled, CODES.green, 39),
    yellow: wrap(enabled, CODES.yellow, 39),
    cyan: wrap(enabled, CODES.cyan, 39),
  };
  const bold = wrap(enabled, 1, 22);
  const inverse = wrap(enabled, 7, 27);
  return {
    bold,
    dim: wrap(enabled, 2, 22),
    ...colors,
    badge: (s, color) => bold(colors[color](inverse(` ${s} `))),
  };
}

/** Follows the NO_COLOR / FORCE_COLOR conventions; Actions logs render ANSI even without a TTY. */
export function colorEnabled(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0';
  }
  if (env.GITHUB_ACTIONS === 'true') {
    return true;
  }
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

export function stdoutStyle(): Style {
  return createStyle(colorEnabled(process.stdout));
}

export function stderrStyle(): Style {
  return createStyle(colorEnabled(process.stderr));
}
