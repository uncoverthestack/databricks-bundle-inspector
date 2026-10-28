# Unreleased changes

One file per change, so two pull requests never edit the same lines of `CHANGELOG.md`.

Name it after the issue, then a few words: `269-sign-in-says-why.md`. The first line is the section, then the entry exactly as it should read in the CHANGELOG:

```markdown
Added

- **The sign-in banner says which profile it signs in as, and why** ([#269](https://github.com/uncoverthestack/databricks-bundle-inspector/issues/269)). Before you click ...
```

Sections: Added, Changed, Deprecated, Removed, Fixed, Security. A file can hold several `- ` entries, all in its one section.

- `npm run changelog:check` checks every file here. CI runs it, so a malformed file fails the pull request.
- `npm run changelog:preview` prints what the next release adds.
- `npm run changelog:release`, in the release pull request, moves every file into `## [Unreleased]` in `CHANGELOG.md` (newest issue first, at the top of its section) and deletes them. Then rename `[Unreleased]` to the version as usual.

Fixing an entry that is already in `CHANGELOG.md` (a typo, a duplicate) is still an edit to `CHANGELOG.md`.
