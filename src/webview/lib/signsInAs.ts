/**
 * The sign-in banner's grey line: the name the sign-in will use, and where it comes from,
 * shown before the click so the name in the terminal is no surprise.
 */

export type ProfileSource = "default" | "setting" | "environment" | "bundle" | "existing" | "new";

export const PROFILE_SOURCES: readonly ProfileSource[] = ["default", "setting", "environment", "bundle", "existing", "new"];

export interface SignsInAsLine {
  /** "Signs in as", or "Signs in again as" for a profile that already exists. */
  lead: string;
  profile: string;
  /** The rest of the sentence, after the name. */
  rest: string;
  /** The name is the Profile setting, which the user can change from here. */
  change: boolean;
}

export function signsInAsLine(target: string, { profile, source }: { profile: string; source: ProfileSource }): SignsInAsLine {
  const line = (rest: string, lead = "Signs in as", change = false) => ({ lead, profile, rest, change });
  switch (source) {
    case "default":
      return line(`: ${target} has no workspace address, so the Databricks CLI checks it with DEFAULT.`);
    case "setting":
      return line(", the profile in your settings.", "Signs in as", true);
    case "environment":
      return line(", from DATABRICKS_CONFIG_PROFILE in your environment.");
    case "bundle":
      return line(", from workspace.profile in the bundle.");
    case "existing":
      return line(", your profile for this workspace.", "Signs in again as");
    case "new":
      return line(`, a new profile named after ${target}'s workspace address.`);
  }
}
