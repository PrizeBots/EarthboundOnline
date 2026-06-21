# Credits & Acknowledgements

Zexonyte Online is a fan project. It is built on the work of many other
people and projects. This file lists everything we use and who deserves credit.

> **Note:** We never distribute ROM-derived data. _EarthBound_ assets stay in
> the player's own browser (see [CLAUDE.md](CLAUDE.md) → "ROM & Asset Distribution").
> The credits below cover the **tools and code** we use, not redistributed content.

---

## Original Game

- **EarthBound / MOTHER 2** — © Nintendo / Ape Inc. / HAL Laboratory.
  Created by Shigesato Itoi. All original characters, sprites, music, maps, and
  data tables are the property of their respective owners. This is a
  non-commercial fan work.

## Asset Extraction Pipeline (`tools/`, Python)

- **[CoilSnake](https://github.com/pk-hack/CoilSnake)** — the EarthBound
  decompilation/modding toolkit. We use its Python libraries
  (`coilsnake.model.eb.*`, `coilsnake.model.common.blocks`, etc.) to parse
  `EarthBound.sfc` — tilesets, maps, sprites, collision, NPC/door data, and the
  enemy/item configuration tables. The `eb_project/` directory is a CoilSnake
  decompiled project.
- **[Pillow (PIL)](https://python-pillow.org/)** — image composition for sprite
  sheets and BG/FG tile atlases.
- **[PyYAML](https://pyyaml.org/)** — reads CoilSnake's `.yml` data tables.
- **Python 3.10** — extraction scripts runtime.

## Audio

- **[@smwcentral/spc-player](https://www.npmjs.com/package/@smwcentral/spc-player)**
  — SPC700 emulation in the browser, courtesy of SMW Central. Lets us run
  EarthBound's native music engine instead of pre-rendered audio.

## Game Engine & Web Client (`src/`, TypeScript)

- **[TypeScript](https://www.typescriptlang.org/)** — engine language.
- **[Vite](https://vitejs.dev/)** — dev server (port 4444) and production build.

## Multiplayer Server (`server/`, Node.js)

- **[Express](https://expressjs.com/)** — HTTP server.
- **[ws](https://github.com/websockets/ws)** — WebSocket transport for the
  shared-world multiplayer relay.
- **[nodemon](https://nodemon.io/)** — dev auto-reload.
- Type definitions: `@types/express`, `@types/ws`.

## Dev Tooling & Quality Gates

- **[Vitest](https://vitest.dev/)** — unit test runner for the TS engine and
  data validation (`npm run test:unit`). The dependency-free Node smoke tests in
  `server/*.test.js` still run separately via `npm run test:server`.
- **[Zod](https://zod.dev/)** — runtime schema validation for the hand-edited
  `public/overrides/*.json` files (`src/data/overrideSchemas.ts`).
- **[ESLint](https://eslint.org/)** + **[typescript-eslint](https://typescript-eslint.io/)**
  — linting.
- **[Prettier](https://prettier.io/)** — formatting (`eslint-config-prettier`
  keeps the two from fighting).
- **GitHub Actions** — CI runs `npm run verify` (typecheck + lint + server
  syntax + tests) on every push/PR.

## Long-Term Hardware Ambition (backlogged, out of scope)

- **[PVSnesLib](https://github.com/alekmaul/pvsneslib)** — C SDK for SNES
  homebrew, for an eventual native ROM port.
- **ESP32** — co-processor concept for real-time multiplayer on real hardware.

---

_If we've used your work and missed it here, it's an oversight — please open an
issue and we'll add you._
