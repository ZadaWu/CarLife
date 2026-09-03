// themes — default / cockpit(车机大字号)
// token 以 CSS 自定义属性提供，由使用方 import "./tokens.css"（或包内 styles 入口）。
export type ThemeName = "light" | "dark";
export const THEMES: readonly ThemeName[] = ["light", "dark"] as const;
