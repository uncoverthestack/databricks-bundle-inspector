/** Plain locations for copied reports, shared with the webview. Never make remote links. */
export function reportLocation(file?: string, line?: number, bundleRoot?: string): string {
  if (!file) return "";
  // Both Windows and POSIX paths occur in saved reports. Avoid node:path in the webview.
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.replaceAll("\\", "/").split("/")) {
      if (part === ".") continue;
      if (part === ".." && parts.length > 1) parts.pop();
      else parts.push(part);
    }
    return parts.join("/").replace(/\/$/, "");
  };
  const full = normalize(file);
  const root = bundleRoot ? normalize(bundleRoot) : undefined;
  const windows = /^[A-Za-z]:\//.test(full);
  const within = root && (windows ? full.toLowerCase().startsWith(root.toLowerCase() + "/") : full.startsWith(root + "/"));
  const name = within ? full.slice(root.length + 1) : full;
  return `${name}${line && line > 0 ? `:${line}` : ""}`;
}
