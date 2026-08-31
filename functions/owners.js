// Shared owner directory + docs section -> owner routing.
// Imported by both functions/report.js (row building) and
// scripts/detect-staleness.mjs (detection), so there is one source of truth.

export const OWNER_DIRECTORY = {
  janice: { name: "Janice Rodrigues", email: "janice.rodrigues@contentstack.com" },
  anaum: { name: "Anaum Hasan", email: "anaum.hasan@contentstack.com" },
  romy: { name: "Romy Dias", email: "romy.dias@contentstack.com" },
  varsha: { name: "Varsha Sreenivas", email: "varsha.sreenivas@contentstack.com" },
  ankita: { name: "Ankita Behere", email: "ankita.behere@contentstack.com" },
  aravindh: { name: "Aravindh S", email: "aravindh.s@contentstack.com" },
  onyx: { name: "Azariah Onyx", email: "azariahj.onyx@contentstack.com" },
};

export const OWNER_OPTIONS = Object.values(OWNER_DIRECTORY).map((owner) => owner.name);

// Ordered rules: the first matching URL fragment decides the product area + owners.
// Keep the most specific fragments first.
const SECTION_RULES = [
  { match: ["/apis", "/content-delivery-api", "/content-management-api", "/graphql"], area: "APIs", owners: ["janice", "romy"] },
  { match: ["/cli"], area: "CLI", owners: ["aravindh"] },
  { match: ["/sdks", "/sdk", "/mobile-sync", "/static-site-generators"], area: "SDKs", owners: ["aravindh"] },
  { match: ["/launch"], area: "Launch", owners: ["varsha"] },
  { match: ["/marketplace", "/developer-hub", "/marketplace-apps"], area: "Marketplace", owners: ["anaum"] },
  { match: ["/automation-hub", "/automate", "/agent-os"], area: "Automate and Agent OS", owners: ["ankita"] },
  { match: ["/personalize"], area: "Personalize", owners: ["onyx"] },
  { match: ["/data-and-insights", "/lytics"], area: "Data and Insights", owners: ["onyx"] },
  { match: ["/scim", "/administration", "/organization", "/teams", "/security"], area: "Organization", owners: ["romy"] },
  { match: ["/visual-editor", "/content-managers", "/studio", "/live-preview"], area: "Studio", owners: ["janice"] },
  { match: ["/assets", "/asset-management"], area: "Assets", owners: ["janice"] },
];

const DEFAULT_RULE = { area: "Contentstack Docs", owners: ["janice"] };

// Return { productArea, ownerIds } for a docs URL.
export function routeOwners(docUrl) {
  const path = String(docUrl || "").toLowerCase();
  for (const rule of SECTION_RULES) {
    if (rule.match.some((fragment) => path.includes(fragment))) {
      return { productArea: rule.area, ownerIds: rule.owners };
    }
  }
  return { productArea: DEFAULT_RULE.area, ownerIds: DEFAULT_RULE.owners };
}

export function resolveOwners(ownerIds) {
  return (ownerIds || [])
    .map((ownerId) => OWNER_DIRECTORY[ownerId])
    .filter(Boolean);
}
