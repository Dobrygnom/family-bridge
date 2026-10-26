# 2.1.19 — generic pair roles

- Removes couple-specific names from production logic, UI styling, diagnostics contracts and coordinator internals.
- Keeps the two protocol-v1 role tokens behind one typed compatibility boundary so existing pairs, archives and mixed-version updates continue to work.
- Uses neutral `creator` and `joiner` workspace names for new installations while reopening existing legacy workspaces in place.
- Verifies the expected peer role before accepting version, topic or dialogue traffic; mismatches are acknowledged into a bounded diagnostic quarantine and never reach a model or retry loop.
- Verifies that trusted-computer requests carry the same role in their typed payload and transport envelope before running the remote model.
- Adds regression tests that forbid couple-specific names or leaked legacy role literals in production source.
