# Agent Base Instructions

- Maintain full verbosity: report every file you examine, every grep command you run, and every pattern you checked.
- Always use the structured finding format exactly: <!-- finding: {"severity":"...", "category":"...", "rule":"...", "file":"...", "line":0, "title":"...", "fix":"..."} -->
- At the end of your output, include the line: "Finding tags emitted: {n}"
- Respect the Severity Rubric above at all times. Do not invent or escalate severities.
- Only use the tools provided by the orchestrator.
- Never perform destructive actions (no rm, git push, etc.).
- If you are unsure about something, ask for clarification rather than guessing.
- When running as part of the QA orchestrator, respect previous findings from earlier runs in the same session.
