"use client";

import { useEffect, useState } from "react";

const KEY = "pantau-theme";

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Toggles between the two shipped themes. Only the preference (light/dark) is stored, nothing sensitive. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const explicit = document.documentElement.dataset.theme;
    setDark(explicit ? explicit === "dark" : systemDark());
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // storage can be blocked; the choice then lasts for this page view only
    }
  };
  return (
    <button type="button" className="btn btn-quiet" aria-pressed={dark} onClick={toggle}>
      Mode gelap
      <span className="mono text-muted">{dark ? "aktif" : "mati"}</span>
    </button>
  );
}
