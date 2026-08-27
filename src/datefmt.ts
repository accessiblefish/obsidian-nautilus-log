/**
 * Minimal moment-style date format/parse for daily-note filename matching.
 * Supports the common tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH mm ss.
 * Replacing the obsidian moment re-export keeps the lint surface free of
 * untyped `any` and drops a dependency.
 */

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));
const DAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const DAYS_SHORT = DAYS_LONG.map((d) => d.slice(0, 3));

const pad = (n: number) => String(n).padStart(2, "0");

const FORMAT_TOKEN_RE = /YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss/g;

export function formatDate(date: Date, format: string): string {
  return format.replace(FORMAT_TOKEN_RE, (t) => {
    switch (t) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return pad(date.getFullYear() % 100);
      case "MMMM":
        return MONTHS_LONG[date.getMonth()];
      case "MMM":
        return MONTHS_SHORT[date.getMonth()];
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "DD":
        return pad(date.getDate());
      case "D":
        return String(date.getDate());
      case "dddd":
        return DAYS_LONG[date.getDay()];
      case "ddd":
        return DAYS_SHORT[date.getDay()];
      case "HH":
        return pad(date.getHours());
      case "mm":
        return pad(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      default:
        return t;
    }
  });
}

type Role = "year" | "month" | "day" | "ignore";

const PARSE_TOKENS: [string, string, Role][] = [
  ["YYYY", "(\\d{4})", "year"],
  ["YY", "(\\d{2})", "year"],
  ["MMMM", `(${MONTHS_LONG.join("|")})`, "month"],
  ["MMM", `(${MONTHS_SHORT.join("|")})`, "month"],
  ["MM", "(\\d{2})", "month"],
  ["M", "(\\d{1,2})", "month"],
  ["DD", "(\\d{2})", "day"],
  ["D", "(\\d{1,2})", "day"],
  ["dddd", `(${DAYS_LONG.join("|")})`, "ignore"],
  ["ddd", `(${DAYS_SHORT.join("|")})`, "ignore"],
  ["HH", "(\d{2})", "ignore"],
  ["mm", "(\d{2})", "ignore"],
  ["ss", "(\d{2})", "ignore"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strict full-string parse of `text` against a moment-style `format`.
 * Returns a Date at local midnight, or null when the text does not match or
 * the date is invalid (e.g. month 13, February 30).
 */
export function parseDateStrict(text: string, format: string): Date | null {
  let pattern = "";
  const roles: Role[] = [];
  let i = 0;
  outer: while (i < format.length) {
    for (const [token, re, role] of PARSE_TOKENS) {
      if (format.startsWith(token, i)) {
        pattern += re;
        roles.push(role); // every token contributes exactly one capture group
        i += token.length;
        continue outer;
      }
    }
    pattern += escapeRe(format[i]);
    i++;
  }
  const m = new RegExp(`^${pattern}$`).exec(text.trim());
  if (!m) return null;

  let year = 0;
  let month = 0;
  let day = 0;
  let group = 1;
  for (let j = 0; j < roles.length; j++) {
    const role = roles[j];
    const raw = m[group++];
    if (raw === undefined) continue;
    if (role === "year") {
      year = raw.length === 2 ? 2000 + parseInt(raw, 10) : parseInt(raw, 10);
    } else if (role === "month") {
      const named =
        MONTHS_LONG.indexOf(raw) + 1 || MONTHS_SHORT.indexOf(raw) + 1;
      month = named > 0 ? named : parseInt(raw, 10);
    } else if (role === "day") {
      day = parseInt(raw, 10);
    }
  }
  if (!year || !month || !day || month > 12) return null;

  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}
