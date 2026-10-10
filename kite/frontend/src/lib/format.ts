export const fmtPrice = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtSignedPct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export const fmtMultiple = (v: number) => `${v.toFixed(2)}x`;

export const pctClass = (v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? "" : v > 0 ? "pos" : "neg";
