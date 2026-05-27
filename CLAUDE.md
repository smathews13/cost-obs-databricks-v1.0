# CLAUDE.md — cost-obs-app

Guidelines for Claude Code when working on this codebase.

---

## Git workflow

- After every `git commit`: push to **origin only**

  ```bash
  git push origin main
  ```

- To publish to the public v1 mirror (customer-facing, deliberate review required):

  ```bash
  bash sync-mirror.sh
  ```

  This builds the frontend, clears the tsbuildinfo cache, and pushes to `smathews13/cost-obs-databricks-v1.0`.

---

## UI style guidelines (Impeccable + Databricks brand)

### Anti-patterns — never introduce these

| Anti-pattern | Rule |
|---|---|
| **Purple** | No `#8B5CF6`, `bg-purple-*`, `text-purple-*`, `border-purple-*` anywhere |
| **Side-Tab Cards** | No `border-l-4` for status — use `bg-red-50 border border-red-200` etc. |
| **Cardocalypse** | Static panels: no `shadow-sm`. Only interactive cards get shadows |
| **Inter font** | Use system font stack only, never import Inter |
| **Bad contrast** | `text-gray-400` fails WCAG AA — minimum is `text-gray-500` |
| **Invalid z-index** | `z-9999` is invalid Tailwind v4 — use `z-[9999]` |
| **animate-bounce** | Use `animate-pulse` with staggered `[animation-delay]` instead |

### Databricks brand palette

| Purpose | Value |
|---|---|
| Primary / CTAs / section titles | `#FF3621` (orange) |
| Dark headers / nav | `#1B3139` (navy) |
| Accent / charts | `#06B6D4` (cyan) |
| Secondary charts | `#3B82F6` (blue) |
| Purple | **Never** |

### Component conventions

- **User/owner pills**: `bg-gray-100 text-gray-700`
- **Planned/pending badges**: `bg-amber-50 text-amber-700 border-amber-200`
- **Interactive KPI cards**: `shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01]`
- **Static content panels**: no shadow
- **Focus rings**: `focus:border-[#FF3621] focus:ring-1 focus:ring-[#FF3621]`
- **Disabled buttons**: `#FFA390`; enabled: `#FF3621`
- **AI/Genie icons**: brand orange, not purple

### PDF export (`client/src/utils/pdfExport.ts`)

- `DB_HEADER: [27, 49, 57]` — table header fill (navy)
- `DB_ORANGE: [255, 54, 33]` — section titles (h1, fontSize 14) + footer rule
- `DB_HEADER` color — subsection titles (h2, fontSize 12)
- `DB_ALT_ROW: [248, 249, 250]` — `alternateRowStyles` on all striped tables
- Page 1: full-width orange bar at top, white title text
- Every page footer: thin orange rule above page number

### Before committing any new UI code

Run a purple check:
```
grep -r "#8B5CF6\|text-purple-\|bg-purple-\|border-purple-" client/src --include="*.tsx"
```
Result must be zero.

---

## app.yaml

`app.yaml` is committed as a clean template (no credentials). Workspace-specific values (warehouse ID, Genie space, etc.) are configured via the Databricks Apps UI — never hardcode them in this file.
