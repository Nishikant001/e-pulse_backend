# Pharma DMS — UI/UX Foundation (Phase 2)

| | |
|---|---|
| **Scope** | Reusable design system + application shell (sidebar, header, responsive behaviour). No new business features. |
| **Preserved** | Distributor login and all auth endpoints, every existing route and API, Phase 1 security fixes, database, backend (**zero backend changes in Phase 2**) |
| **New dependencies** | **None.** Built only on packages already in `package.json` (React 19, react-router-dom, Tailwind 4, lucide-react, recharts) |
| **Companion docs** | `PHARMA_DMS_ARCHITECTURE_AUDIT.md`, `PHARMA_DMS_MODULE_MAPPING.md` |

## 0. Verification status — read first

**What was verified (and how)**

| Check | Method | Result |
|---|---|---|
| Syntax + import resolution of all 124 frontend source files | TypeScript parser + resolver, plus esbuild bundling of the real `App.jsx` | Pass |
| Undeclared / unused identifiers in all new code | TypeScript semantic check (`checkJs`) | 0 issues |
| Every design-token utility class used in new code is defined in `tokens.css` | Script | 0 undefined |
| Shell + design-system behaviour: navigation, sidebar collapse/expand, planned-item handling, global search, menus, modals, drawer, focus trap, focus restore, toasts, `useConfirm`, table sort/search/paginate/states, tabs, filters, tooltip, date-range validation, tablet and mobile drawer | **76 automated browser checks** in headless Chromium with React 19 (development build) | 76 / 76 pass, no console errors or warnings |
| All 34 existing `/dashboard` routes (index + 33 pages) + 4 auth pages open inside the new shell | Same browser harness, real `App.jsx`, real page code, mocked `fetch`; compared with the original upload | No new console errors; all render (the logout route correctly ends on the login page, as before) |
| Route guard intact; Sign out calls `POST /api/logout`, clears the stored user, lands on `/login` | Browser test | Pass |
| Backend identical to the Phase 1 deliverable; credential pages and `authFetch.js` byte-identical to Phase 1; no secrets in frontend source | `diff` + grep | Pass |

**What was NOT verified — please do these locally before sign-off**

The audit sandbox has no npm registry access and no Tailwind compiler, so:

- **`npm install`, `npm run lint`, `npm run build`, real Vite dev server: not run.**
- **Visual appearance is unverified.** Colours, spacing, shadows, the sidebar transition, and every CSS-driven responsive rule (`hidden md:block`, grid columns, etc.) have not been seen rendered. The browser tests use stub CSS-less markup, so they prove behaviour and accessibility semantics, not looks.
- **Real react-router and real lucide-react** were replaced by small stubs in the browser harness. Icon names new to this codebase (e.g. `CircleHelp`, `LoaderCircle`, `Ellipsis`, `PanelLeftClose`) exist in lucide-react 0.5xx to the best of my knowledge, but a missing one would fail `npm run build` loudly.
- **Real backend/API, real login, real data:** not exercised (backend was not started; data was mocked).
- **Screen-reader, contrast measurement and real-device testing:** not done. Contrast values in §3 are calculated, not measured.
- **The standalone Pharma DMS demo and the senior's requirements document were not provided.** The palette, layout and IA follow your written brief. Once the demo is available, expect to retune `tokens.css` (single file) rather than components.

Local verification checklist:

```bash
cd secondary_frontend && npm install && npm run lint && npm run build && npm run dev
# backend (unchanged): cd ../secondary_backend && npm install && npm start
```
Then: log in → dashboard loads inside the new shell → open every sidebar item → resize to tablet (≈900 px) and phone (≈390 px) widths → `Sign out` → open `/dashboard` in a private window (must redirect to `/login`) → open **`/dashboard/design-system`** (development builds only) and step through each section.

## 1. Design principles

1. **One source of truth.** Colours, type, radius, shadow and motion live in `src/styles/tokens.css`. Components use utilities (`bg-brand-600`, `text-ink-muted`, `rounded-card`) — no raw hex in components.
2. **Premium, restrained, light.** White surfaces on a very light canvas, one professional blue, soft borders, small shadows, moderate radius (8–12 px). No dark gradients, no decorative colour.
3. **Status is never colour alone.** Every status has an icon and a text label.
4. **Presentational components own no data.** KPI cards, charts, filters, notification bell, SAP indicator and identity display are prop-driven — nothing fake is hard-coded into them.
5. **Honest placeholders.** Features that do not exist yet are shown as planned/disabled, not as working screens or fake numbers.
6. **Additive.** Existing pages keep working unchanged; they are migrated gradually.

## 2. File structure

```
src/
  styles/        tokens.css (design tokens) · base.css (focus, motion) · legacy-bridge.css · tokens.js (chart colours)
  components/
    ui/          primitives, status system (statusConfig.js) and barrel (index.js)
    layout/      AppShell · Sidebar · Header · GlobalSearch · NotificationBell · HelpMenu · ScopeSelector · SapStatusIndicator
    tables/      DataTable
    forms/       filters (Select/Search/DateRange + Distributor, Retailer, Product, Category, Batch, Status, Territory, SAP status) 
    dashboard/   ChartCard · ChartTooltip · DataTableCard · AlertCard · ActivityCard · ProgressCard (+ KpiCard/TrendIndicator re-exports)
    feedback/    FeedbackProvider · useToast · useConfirm
    Distributers/  existing business screens (unchanged)
  config/        navigation.js (nav model) · portals.js (portal definitions)
  hooks/         useMediaQuery/useBreakpoint · useLocalStorage · useDialogBehavior · useDebouncedValue
  utils/         cn · format (₹ / Cr / L) · dateRanges (incl. Indian FY) · session (stored user, logout)
  pages/         DesignSystemPage (development builds only)
  routes/        ProtectedRoute (Phase 1)
```
Import primitives from the barrel: `import { Button, Card, StatusBadge } from "../../components/ui"`.

## 3. Design tokens

### Colour (all defined in `tokens.css`)

| Role | Token | Value | Notes |
|---|---|---|---|
| **Brand primary** | `brand-600` | `#0066cc` | 5.6 : 1 with white text. Hover `brand-700`, pressed `brand-800`, tint `brand-50/100`, focus ring `brand-500` |
| Canvas (page) | `canvas` | `#f6f8fb` | app background |
| Surface | `surface` / `surface-muted` | `#ffffff` / `#f8fafc` | cards, header, sidebar / table headers |
| Border | `line` / `line-strong` | `#e2e8f0` / `#cbd5e1` | default / inputs |
| Text | `ink` / `ink-muted` / `ink-subtle` | `#0f172a` / `#475569` / `#5f6f85` | 17.9 : 1 / 7.6 : 1 / 5.1 : 1 on white (4.8 : 1 on canvas) |
| **Success** | `success-50…700` | 700 = `#047857` | |
| **Warning** | `warning-50…700` | 700 = `#b45309` | |
| **Error** | `error-50…700` | 700 = `#b91c1c` | |
| **Info** | `info-50…700` | 700 = `#0369a1` | distinct from brand |
| **Neutral** | `neutral-50…700` | 700 = `#334155` | |

Status badges use the pattern `bg-{tone}-50 text-{tone}-700 ring-{tone}-200`; calculated contrast of the text/background pairs is 4.8 : 1 (warning) to 5.9 : 1 (error) — all ≥ 4.5 : 1 (WCAG AA). Planned (disabled) navigation items are intentionally lower contrast (≈ 3.5 : 1), which WCAG exempts for inactive controls, and they are announced as planned to screen readers. Chart series colours: `styles/tokens.js` (`chartPalette`, brand-led). Keep `tokens.js` in sync with `tokens.css`.

### Typography

Font stack: **Inter → Segoe UI → system-ui** (Inter is *not bundled*; to guarantee it, add `@fontsource-variable/inter` and import it in `main.jsx`).

| Role | Class | Size / line |
|---|---|---|
| Page title | `text-page font-semibold tracking-tight` | 24 / 32 |
| Section title | `text-section font-semibold` | 18 / 28 |
| Card title | `text-card-title font-semibold` | 16 / 24 |
| Body & controls | `text-body` | 14 / 22 |
| Table text, status text | `text-table` | 13 / 20 |
| Caption, helper, secondary | `text-caption` | 12 / 16 |
| KPI value | `text-kpi font-semibold tabular-nums` | 28 / 36 |

Weights: 400 body, 500 labels/buttons, 600 titles. Use `tabular-nums` for figures.

### Other tokens

| Token | Values |
|---|---|
| Radius | `rounded-control` 8 px (buttons, inputs) · `rounded-card` 12 px (cards, tables) · `rounded-overlay` 12 px (modals, drawers, menus) · `rounded-full` (badges, avatars) |
| Shadow | `shadow-card` (resting) · `shadow-hover` · `shadow-popover` (menus) · `shadow-overlay` (dialogs) |
| Spacing | Tailwind 4 px scale. Page padding 16 / 24 px; card padding 20 px; control height 32 / 36 / 44 px |
| Motion | `--dur-fast` 120 ms · `--dur-base` 180 ms · `--dur-slow` 260 ms · `--ease-standard` cubic-bezier(0.2, 0, 0, 1) |
| Layout | `--sidebar-width` 264 px · `--sidebar-width-rail` 72 px · `--header-height` 64 px |

## 4. Component catalogue

### Primitives (`components/ui`)

| Component | Purpose / key props | Notes |
|---|---|---|
| `Button` | variant `primary·secondary·subtle·ghost·danger·danger-outline`, size `sm·md·lg`, `loading`, `leftIcon/rightIcon`, `as` | `loading` → disabled + spinner + `aria-busy` |
| `IconButton` | `icon`, **`label` (required)**, variant, size, `badge` | label = accessible name + tooltip |
| `Input`, `Textarea` | `label`, `hint`, `error`, `required`, `leftIcon`, `rightSlot` | label/hint/error wired with `htmlFor` / `aria-describedby` / `aria-invalid` |
| `Select` | `options`, `placeholder`, label/hint/error | native `<select>` (best keyboard + mobile) |
| `SearchInput` | `value`, `onChange(string)`, `debounceMs` | clear button, Esc clears |
| `DatePicker` | ISO string value; controlled or `defaultValue` | native date input |
| `DateRangePicker` | `value {from,to,presetId}`, presets (Today, 7 d, 30 d, month, last month, **financial year Apr–Mar**), custom range with validation | popover |
| `Card`, `CardHeader/Body/Footer` | surface, optional hover elevation | |
| `KpiCard` | `title, value, icon, trend{direction,value,sentiment}, comparison, status, footer`, `loading`, `error/onRetry`, `onClick` | no data of its own; `sentiment` handles "up is bad" (e.g. returns) |
| `TrendIndicator` | arrow + value; direction spoken to screen readers | |
| `Badge` | tone, soft/outline, dot, icon | generic label |
| `StatusBadge` | `status`, `domain` | see §6 |
| `Pagination` | 1-based, controlled, page-size selector, "Showing a–b of n" | compact on phones |
| `Dropdown` | `items` (label, icon, onClick/to, danger, disabled, divider, header, hint) | `role=menu`, arrows/Home/End/Esc/Tab |
| `Popover` | anchored floating panel (portalled, viewport-aware, flips) | base of Dropdown, DateRangePicker, bell |
| `Modal`, `Drawer`, `ConfirmationModal` | title, description, footer, size; drawer side left/right | shared `DialogShell`: focus trap, focus restore, Esc, scroll lock, `aria-modal` |
| `Tabs` | `tabs[]`, controlled/uncontrolled, underline/pills | arrows/Home/End, skips disabled |
| `Tooltip` | hover **and** keyboard focus, `aria-describedby`, portalled | for icon-only actions |
| `Alert` | tone info/success/warning/error, title, action, dismiss | error/warning = `role=alert` |
| `EmptyState`, `ErrorState`, `LoadingState` | icon/title/description/action; retry; spinner | `LoadingState` is `role=status` |
| `Skeleton`, `SkeletonText/Card/Table` | shimmer placeholders | decorative (`aria-hidden`) |
| `Breadcrumb`, `PageHeader`, `SectionHeader` | page/section chrome | `aria-current="page"` |
| `ProgressBar` | value/max, tone, label | `role=progressbar` |
| `Avatar` | initials or image, size | decorative unless `label` given |
| `UserMenu` | avatar + account menu; identity and actions supplied by caller | |
| `FilterBar` | responsive filter container + "Clear filters (n)" | |

### Composite

| Component | Purpose |
|---|---|
| `DataTable` (`components/tables`) | Columns with `render`, `sortable`, `align`, `sticky` (frozen first column), `hideOnMobile`; built-in search, sort, pagination (client mode) **or** `manual` server mode; row actions menu; `onRowClick` (keyboard accessible); sticky header via `maxHeight`; horizontal scroll; `responsive="cards"` stacked layout on phones; loading / error+retry / empty / no-matches states |
| Filters (`components/forms`) | `SearchFilter`, `DateRangeFilter`, `SelectFilter` and presets `DistributorFilter`, `RetailerFilter`, `ProductFilter`, `CategoryFilter`, `BatchFilter`, `StatusFilter(domain)`, `TerritoryFilter`, `SapStatusFilter` — UI only; caller owns state/options |
| Dashboard blocks (`components/dashboard`) | `ChartCard` (+ `ChartTooltip` for Recharts), `DataTableCard`, `AlertCard`, `ActivityCard`, `ProgressCard`, `KpiCard`, `TrendIndicator` |
| Feedback (`components/feedback`) | `FeedbackProvider` (mounted in `main.jsx`), `useToast()`, `useConfirm()` |

### Loading / empty / error / success coverage

Data-bearing components (`DataTable`, `KpiCard`, `ChartCard`, `ActivityCard`, `AlertCard`, `ProgressCard`) support **loading** (skeleton), **empty** (message + action) and **error** (message + retry). **Success** feedback is delivered by `toast.success`, `Alert tone="success"`, and success statuses. Pure primitives (Button, Input…) expose loading/disabled/error only where meaningful; they are not given artificial empty states.

## 5. Application shell

`AppShell` (portal-agnostic) = sidebar + header + routed content (`<Outlet/>`), with a skip-to-content link and an opacity-only page-entrance animation. `DashboardLayout` (existing route element, unchanged path) now renders `<AppShell portal={distributorPortal} />`. The legacy `Sidebar.jsx` path is kept as a thin wrapper so any import still works.

### Portals
`config/portals.js` defines a portal = `{ id, label, basePath, navigation, sapStatus, getIdentity() }`. Only `distributorPortal` exists (`/dashboard/*`, existing login). `/admin/*` and `/retailer/*` will be added as further portal objects + route groups in later phases; nothing in the shell is Distributor-specific. Identity is the real logged-in distributor (name, distributor code, email) from the stored login response — **no fake "Admin User / Super Admin"**.

### Sidebar and navigation model (`config/navigation.js`)
Groups: Dashboard · Sales · Purchase · Inventory · Masters · Distributor Management · Retailer Management · Schemes & Claims · Accounts · SAP Integration · Reports · Notifications · Audit Logs · Settings — matching the requested structure. Each item is either **live** (has a route) or **planned**.

- **Live (30 routes, all previously reachable):** Sales Orders, Deliveries, Sales Invoices, Sales Returns, Credit Notes, Debit Notes · Purchase (5) · Current/Batch Stock, Stock Ledger · Product Master (`material-master`), Batch Master (`stock-master`), Customer Master (previously labelled "Retailers"), Vendor Master, Pricing Master, Tax Master (HSN), Customer/Vendor/Item Groups · Customer/Vendor Ledger, Payments, GL Master, Trial Balance, Balance Sheet.
- **Planned (shown muted with a small dot, not clickable, announced as "planned, not available yet"):** Secondary Sales, Near Expiry, Expired Stock, Stock Transfer, FEFO Monitor, Distributor/Retailer Master, Scheme Master, all of Distributor Management, Retailer Management, Schemes & Claims, SAP Integration, Reports, plus Notifications, Audit Logs, Settings. No "Coming soon" banners or pages. A footer toggle **"Hide planned modules"** shows only working screens (preference remembered).
- Existing functional routes that are not in the requested IA (Deliveries, Debit Notes, all Purchase screens, group masters) were kept in the nearest group so nothing became unreachable. The two commented-out legacy invoice links were not restored.
- To add a screen: add its route in `App.jsx` and change the item from `planned(...)` to `{ id, label, to }`.

### Header
Left: menu button (tablet/mobile), breadcrumb (derived from route + nav model) and page title. Right: **global search** (jump-to-page over live navigation; `/` or Ctrl/⌘+K; entity search needs a backend search API later) · **date range** (shell-level context via `useDateRange()`; legacy screens do not consume it yet) · **SAP status** (`connected / degraded / disconnected / not configured` — currently and honestly *"SAP not configured"*) · **notification bell** (empty state until a notification backend exists) · **help** (keyboard shortcuts; design-system link in development builds) · **distributor scope chip** (static for one scope, switcher for many — ready for Admin) · **user menu** (identity + Sign out). Sign out moved from the sidebar footer into the user menu; it performs the same logout (POST `/api/logout`, clear stored user, go to `/login`).

### Responsive behaviour

| Viewport | Sidebar | Header | Content |
|---|---|---|---|
| **Desktop ≥ 1024 px** | Expanded 264 px; collapsible to a 72 px icon rail (remembered in `localStorage`); clicking a group icon in the rail re-expands | Full: breadcrumb, search, date range, SAP, bell, help, scope, user | Padded to sidebar width (animated) |
| **Tablet 768–1023 px** | 72 px icon rail; menu button opens the full navigation as a left drawer | Search, bell, help, user (date range/SAP hidden) | Padded to rail |
| **Mobile < 768 px** | Not rendered; menu button opens a left drawer (focus-trapped, Esc, closes after navigation) | Menu, page title, search icon (opens search dialog), bell, user | Full width |

Tables: `DataTable` scrolls horizontally inside its own container, or use `responsive="cards"` for a stacked layout below 768 px. Modals become bottom sheets on phones; drawers become full width.

## 6. Status system (`components/ui/statusConfig.js`)

One definition per status: label + tone + icon. `StatusBadge` resolves by `status` and optional `domain`; unknown values render a neutral badge with a prettified label.

| Domain | Statuses (tone) |
|---|---|
| `salesOrder` | Draft (neutral) · Confirmed (info) · Processing (warning) · Partially delivered (warning) · Fully delivered (success) · Invoiced (success) · Closed (neutral) · Cancelled (neutral) · Synced (success) |
| `inventory` | Healthy (success) · Low stock (warning) · Near expiry (warning) · Expired (error) · Damaged (error) · Quarantine (info) · Active / Inactive |
| `sap` | Synced (success) · Pending (neutral) · Running (info, spinning icon) · Failed (error) · Partial (warning) |
| `claim` | Draft (neutral) · Submitted (info) · Under review (warning) · Approved (success) · Rejected (error) · Settled (success) |
| `delivery`, `invoice` | existing app values: Pending / Dispatched / Delivered / Cancelled · Draft / Posted / Partially paid / Paid / Cancelled |
| `generic` | success · warning · error · info · neutral · active · inactive |

`getStatusOptions(domain)` feeds `StatusFilter`. Existing screens still use their own inline badges until migrated.

## 7. Feedback: toasts and confirmations

```jsx
const toast = useToast();      toast.success("Customer saved");  toast.error("Unable to save", { title: "Save failed" });
const confirm = useConfirm();  if (await confirm({ title: "Delete customer?", message: "…", tone: "danger", confirmLabel: "Delete" })) { … }
```
Toasts: top-right (full width on phones), max 4, auto-dismiss (success 4 s, info 5 s, warning 6 s, error 8 s), pause on hover, dismiss button, `role=status` / `role=alert`. **Existing pages still use `alert()`/`confirm()` (~100 calls)** — replace them screen by screen during migration; a mechanical `alert(msg)` → `toast.info(msg)` swap is safe.

## 8. Accessibility

Implemented and browser-tested unless marked: visible focus ring on every focusable element (`:focus-visible`); every button/icon button has an accessible name; every form control has a label, with errors/hints linked via `aria-describedby` and `aria-invalid`; dialogs/drawers are `role=dialog aria-modal` with a focus trap, Escape to close and focus restored to the trigger; menus (`role=menu`) and tabs support arrow/Home/End keys; combobox search with `aria-activedescendant`; sortable headers expose `aria-sort`; tables have header scope and optional caption; toasts and loading states are announced via live regions; icon-only actions show tooltips on hover and keyboard focus; statuses combine icon + text; planned nav items are `aria-disabled` and announced as planned; skip-to-content link; `prefers-reduced-motion` disables animations; automated sweep found no unlabeled buttons/controls and no duplicate ids on the showcase page.
*Not done:* screen-reader passes (NVDA/VoiceOver), automated axe audit, measured contrast, high-contrast/forced-colours check.

## 9. Animation principles

Subtle and purposeful (120–260 ms, one easing): sidebar width and submenu height, card hover elevation, table-row hover tint, modal pop-in, drawer slide, toast slide-in, skeleton shimmer, opacity-only page entrance. Page entrance is deliberately **opacity-only** — a CSS transform on an ancestor would break the `position: fixed` modals still used by legacy pages. No parallax, bouncing or looping decorative motion; all disabled under `prefers-reduced-motion`.

## 10. Components created / reused / still requiring redesign

**Created (Phase 2):** everything in §2 and §4 (≈ 80 new files, ≈ 4,000 lines), the navigation/portal config, tokens, the design-system page.

**Reused unchanged:** all routes and route paths, `authFetch`, `ProtectedRoute` (Phase 1), Login / Signup / Forgot / Reset pages (visuals untouched by design), every business screen under `components/Distributers/dashboard/**`, Recharts, lucide-react, Tailwind.

**Changed:** `App.jsx` (development-only design-system route), `main.jsx` (mounts `FeedbackProvider`), `DashboardLayout.jsx` (now uses `AppShell`), `Sidebar.jsx` (thin wrapper), `index.css` (imports the style layers).

**Still requiring redesign / migration (later phases):**

| Area | Why |
|---|---|
| All ~30 legacy screens | Own hand-built tables, modals, badges, forms and hard-coded colours; inconsistent spacing; not yet on `DataTable` / `Modal` / `StatusBadge` |
| `Dashboard.jsx` | Hard-coded demo charts and "+12%" figures (generic ERP data) — replace with `KpiCard` / `ChartCard` fed by real endpoints |
| Login / Signup / Forgot / Reset visuals | Functional and unchanged; teal styling differs from the new brand |
| Print templates (delivery note, invoice) | Own HTML; restyle separately |
| `alert()` / `confirm()` (~100 calls) | Migrate to toast / `useConfirm` |
| Legacy broken routes (`/dashboard/delivery`, `invoice/creation`, `invoice/view`) | Still routed; not in navigation; retire in cleanup |
| Legacy palette bridge (`styles/legacy-bridge.css`) | Re-points Tailwind `indigo-*` and `purple-*` to the brand blue so ~130 legacy usages inherit the brand colour. **Remove once screens are migrated.** Side effect to eyeball: places that used purple for contrast now share the brand blue |

## 11. SEO and security preservation

- Title, meta description, theme colour and `robots.txt` (disallowing `/dashboard`, `/admin`, `/distributor`, `/retailer`, reset/forgot pages) from Phase 1 are unchanged; no application data appears in public metadata.
- Auth: `/api/login`, `/signup`, `/logout`, `/refresh-token`, `/forgot-password`, `/verify-otp`, `/reset-password` untouched; credential pages and `authFetch.js` are byte-identical to Phase 1.
- Phase 1 fixes intact: tenant-scoped customer/vendor access, protected update fields (customer, vendor, product, pricing), pricing reference checks, `ProtectedRoute`, server-side logout.
- No credentials in frontend code; only `VITE_API_BASE_URL` (public) is configurable. The user menu displays name, code and email already returned by the existing login; nothing else is stored.
- `localStorage` keys added: `dms.sidebar.collapsed`, `dms.sidebar.showPlanned` (UI preferences only).

## 12. Known limitations and recommended next steps

1. **Run the local verification in §0**, especially `npm run build` and a visual pass at desktop / tablet / phone widths; report anything that looks off — token changes are one-file fixes.
2. Provide the **demo** and the **senior's document** so the palette, density and IA can be reconciled before more screens are built.
3. Migrate screens gradually, highest-traffic first, using `PageHeader` + `FilterBar` + `DataTable` + `useToast` (the design-system page shows the target pattern).
4. Add automated tests to the repo (component tests + Playwright smoke) — the audit's browser checks were one-off and are not included.
5. Global search covers navigation only; header date range and notification bell need backend/data wiring; SAP status needs the integration phase.
6. Consider bundling Inter (`@fontsource-variable/inter`) for consistent typography.
7. Bundle size: the design system adds no dependencies; the showcase page is lazy-loaded and development-only.
