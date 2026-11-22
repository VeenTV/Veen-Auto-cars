# Veen Auto car database

The cars [Veen Auto](https://github.com/VeenTV/Veen-Auto) knows: models and
their test status, VIN prefixes, and the hybrid / EV battery tables
(diagnostic addresses, identifiers and formulas) of the table-driven brands.
The app has a copy built in and fetches the newest release from here
(Settings → Car → *Car models*, and weekly in the background).

**License:** [CC BY-SA 4.0](LICENSE.md). Use it, change it, share it – with
attribution and under the same license. See *Attribution* below.

## Files

| File | What |
|---|---|
| `cars.json` | the database (edit this) |
| `tests/recorded.json` | replies recorded on real cars, with the values they must give |
| `tools/check.js` | checks structure, safety rules and the recorded replies: `node tools/check.js` |
| `public-key.txt` | public half of the signing key (the same key is built into the app) |
| `.github/workflows/release.yml` | on every change to `main`: check, stamp version, sign, publish a release |

## Format (schema 1)

```jsonc
{
  "schema": 1,
  "version": "2026.11.22.1",            // set by the release workflow
  "models": [
    { "id": "toyota-rav4-phev", "brand": "Toyota", "name": "RAV4 Plug-in", "years": "2020–",
      "platform": "TOYOTA",               // how the app talks to the battery unit (code in the app)
      "readiness": "NOT_TESTED",          // TESTED | IN_DEVELOPMENT | NOT_TESTED | GENERIC
      "source": "OBDb (CC BY-SA 4.0) …",
      "prefers29Bit": false, "vwVariant": "MQB",   // VW group only
      "minApp": 76 }                      // optional: oldest app versionCode that may use this entry
  ],
  "wmi": { "Toyota": ["JTD", "SB1", …] }, // VIN prefixes per brand
  "tables": {                             // TOYOTA, BMW, MERCEDES
    "TOYOTA": {
      "units":  [{ "id": "hv", "name": "hybrid control 0x7D2", "request": "7D2", "reply": "7DA",
                   "probe": "1F9A", "service": "UDS", "extAddr": "07" /* BMW only */ }],
      "values": [{ "unit": "hv", "id": "1F9A", "name": "Pack voltage", "unitText": "V", "decimals": 1,
                   "rate": "FAST", "key": "bms.D815",
                   "fmt": { "bix": 16, "len": 16, "mul": 156.25, "div": 10000 } }],
      "texts":  [ … ], "series": [ … ], "identity": { … }, "scan": { … }
    }
  }
}
```

Tables: `STELLANTIS` (Citroën, DS, Opel, Peugeot), `VW_MQB` (VW, Cupra,
Škoda, Audi), `HYUNDAI_KIA`, `TOYOTA`, `BMW`, `MERCEDES` – every battery unit
Veen Auto knows.

### Stellantis constructs (app 0.37.0 and newer; older apps ignore the Stellantis table)

| Field | Where | Meaning |
|---|---|---|
| `"variantBy": {"unit", "id", "matches", "default"}` | table | the formulas come from a reply of the car: F08F (battery unit supplier) containing `PHEV` or `LGC` means the plug-in hybrid unit (`PHEV`), else `ECMP` |
| `"clamp": true` | formula | limit to `min`…`max` instead of dropping (the estimated dashboard %) |
| `"alternatives": [{"name", "size", "fmt"}]` | series | formats tried in turn; the first whose values are all within the range wins (unused raw-zero slots at the end dropped) |
| `"rate": "NORMAL"` | series | read with the values every 3rd round instead of with the lists every 20th |
| `"format": "ascii" / "bcdDate" / "productionDate"` | text, 3rd item of an identity entry | named text formats |

### More constructs (app 0.36.0 and newer; older apps ignore the VW and Hyundai tables)

| Field | Where | Meaning |
|---|---|---|
| `"bits29": true` | unit | 29-bit CAN: `request` / `reply` are full IDs (`17FC007B`) |
| `"group": "bms"` | unit | alternatives for the same battery unit (VW 29-bit / 11-bit, Hyundai UDS / KWP): only the first that gives real data is used; with `prefers29Bit` the 29-bit one is tried first |
| `"unit": ["bms29", "bms11"]` | value, text, series | the same entry on several units |
| `"fmts": [ … ]` | value | several formulas, the first that gives a value wins; `minBytes` / `maxBytes` choose by reply length |
| `"variants": ["MLB"]` | value, loop | only for models with that `vwVariant` |
| `"count": 32` | series | at most this many values; series with the same `listKey` are joined in order (Hyundai cell blocks) |
| `"loops": [ … ]` | table | one value per identifier from `first` (VW cells 1E40+): `max`, `outlier` (stop at a value further than this from the median), `stopAtGap`, `minCount`, `modules` / `moduleCells` (module averages) |
| `"scan": {"group": …}`, `"identity": {"group": …}` | table | the group's answering unit |

A formula (`fmt`) takes `len` bits from bit `bix` of the reply data (the
bytes after `62 DID DID`, big-endian, bit 0 = first bit), signed if `sign`;
a raw value ≥ `nullFrom` means "no value"; the value is
`raw × mul ÷ div + add`; results outside `min`…`max` are dropped. This is
the same scheme as [OBDb](https://github.com/OBDb).

**Live value keys** (`key`): `bms.D815` pack voltage, `bms.D816` current
(+ = discharging), `bms.D810` state of charge, `bms.dashpct` charge as the
car shows it, `bms.D817` / `bms.D87D` / `bms.D877` temperature max / min /
average, `bms.D870` / `bms.D86F` cell voltage max / min, `bms.D822` 12 V,
`bms.D860` health, `bms.D865` energy. **List keys** (`series.listKey`):
`cells.D440` cell voltages, `cells.D442` temperatures, `cells.D8AD`
module / block voltages.

### What the data can't do

The app only ever sends read requests (UDS 0x22, KWP 0x21) to 11-bit
diagnostic addresses (0x000–0x7FF), and rejects a database that asks for
anything else. New ways of talking to a car (protocols, addressing) need an
app update; a new `platform` name is ignored by older apps.

## Changing the data

1. Edit `cars.json` (e.g. a model's `readiness` to `TESTED` after reports
   confirm it, or a corrected formula).
2. If you have a recorded reply, add it to `tests/recorded.json`.
3. `node tools/check.js` – then commit to `main` (or open a pull request:
   the check runs there too, without releasing).

The workflow publishes `cars-<version>` with `cars.json` and
`cars.json.sig`; apps pick it up on the next refresh.

## Signing (set up once)

Repository → Settings → Secrets and variables → Actions → **New repository
secret** `CARS_SIGNING_KEY` = the whole private key PEM
(`-----BEGIN EC PRIVATE KEY-----` … `-----END EC PRIVATE KEY-----`). It must
be the private half of `public-key.txt`; the workflow refuses to sign with
any other key. Keep a copy of the key somewhere safe (e.g. a password
manager): a lost key means a new app release with a new public key.

## Attribution

- **OBDb** (<https://github.com/OBDb>), CC BY-SA 4.0 – signal definitions
  for Toyota, Lexus, Suzuki, BMW, Mercedes-Benz, Audi, Škoda, Volkswagen,
  Cupra, Hyundai and Kia, and the recorded replies in `tests/recorded.json`.
  Changed: converted to this format, values renamed, signs aligned to
  "+ = discharging".
- **Esco EV OBD Scanner** by EsaHub (<https://github.com/EsaHub/EscoEvObdScanner>),
  CC BY 4.0 – Stellantis identifiers.
- **Veen Auto** (Veen TV) – Citroën C5 X Hybrid formulas, test status, and
  corrections from Veen Auto car check reports.
