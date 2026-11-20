// Ruby model wire ({node, fields}, nil fields left out) for a generated model.
// Generation 4 rows name the model by the gem's earlier name Unicodemath.
// Ruby tagged model wire used by the pinned corpus replay. Field order,
// unset fields and collection order retain the existing replay semantics.
export function model(v) {
  if (v === null || v === undefined || typeof v === "symbol") return undefined;
  if (typeof v === "string") return { str: v };
  if (Array.isArray(v)) return { array: v.map(model) };
  const name = v.constructor.name;
  if (!name.startsWith("UmathModel")) throw new Error("not a generated model: " + name);
  return {
    node: "Umath::Model::" + name.slice(10),
    fields: Object.entries(v).map(([k, x]) => [k, model(x)]).filter(([, x]) => x !== undefined),
  };
}
