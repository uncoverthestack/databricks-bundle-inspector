export function resolveSelectedJobKey(
  jobKeys: string[],
  userSelectedJobKey?: string,
  initialSelectedJobKey?: string,
): string {
  if (userSelectedJobKey && jobKeys.includes(userSelectedJobKey)) {
    return userSelectedJobKey;
  }

  if (initialSelectedJobKey && jobKeys.includes(initialSelectedJobKey)) {
    return initialSelectedJobKey;
  }

  return jobKeys[0] ?? "";
}
