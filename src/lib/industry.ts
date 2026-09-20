/**
 * Industry labels for job listings. Keyword-based on purpose: it runs on
 * every insert and on the backfill script with no model cost, and the labels
 * only need to be good enough to group a board and filter a list.
 */
export const INDUSTRIES = [
  "Software & IT",
  "Design & Creative",
  "Marketing & Sales",
  "Customer Support",
  "Admin & Virtual Assistance",
  "Finance & Accounting",
  "Human Resources",
  "Healthcare",
  "Education",
  "Engineering & Manufacturing",
  "Logistics & Operations",
  "Hospitality & Retail",
  "Legal",
  "Real Estate & Construction",
  "Other",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

// First match wins, so the more specific groups sit above the generic ones.
// Keys are tested as whole words (case-insensitive) against title + company.
const RULES: Array<[Industry, string[]]> = [
  ["Healthcare", ["nurse", "nursing", "medical", "clinical", "clinic", "pharmacy", "pharmacist", "dental", "dentist", "physician", "doctor", "caregiver", "health", "hospital", "therapist", "radiolog", "laboratory technician", "medtech", "patient"]],
  ["Legal", ["lawyer", "attorney", "paralegal", "legal", "compliance officer", "notary", "litigation"]],
  ["Education", ["teacher", "tutor", "instructor", "professor", "lecturer", "trainer", "esl", "education", "school", "academic", "curriculum", "admissions"]],
  ["Design & Creative", ["designer", "graphic", "ui/ux", "ux", "ui designer", "illustrator", "animator", "video editor", "photographer", "creative", "art director", "motion", "3d artist", "copywriter", "content writer", "writer"]],
  ["Software & IT", ["developer", "engineer", "software", "programmer", "devops", "sre", "qa", "tester", "test engineer", "data scientist", "data analyst", "data engineer", "machine learning", "ml ", "ai ", "flutter", "react", "node", "python", "java", "php", "laravel", "ios", "android", "mobile app", "full stack", "fullstack", "front end", "frontend", "back end", "backend", "web dev", "wordpress", "shopify developer", "it support", "system admin", "sysadmin", "network", "cybersecurity", "security analyst", "database", "dba", "cloud", "aws", "azure", "technical support", "it ", "information technology", "solutions architect", "product manager", "scrum", "project manager"]],
  ["Finance & Accounting", ["accountant", "accounting", "bookkeeper", "bookkeeping", "payroll", "finance", "financial", "auditor", "audit", "tax", "treasury", "billing", "accounts payable", "accounts receivable", "cpa", "controller", "credit", "loan", "banking", "bank", "collections"]],
  ["Human Resources", ["hr ", "human resource", "recruiter", "recruitment", "talent", "sourcer", "sourcing specialist", "people operations", "staffing", "onboarding", "compensation"]],
  ["Marketing & Sales", ["marketing", "seo", "sem", "ppc", "social media", "content marketing", "brand", "growth", "sales", "account executive", "account manager", "business development", "bdr", "sdr", "lead generation", "appointment setter", "cold caller", "telemarketer", "outreach", "e-commerce", "ecommerce", "amazon", "etsy", "ebay", "shopify", "dropship", "lister", "affiliate", "advertis", "campaign", "crm", "gohighlevel"]],
  ["Customer Support", ["customer service", "customer support", "customer success", "csr", "call center", "contact center", "support agent", "support specialist", "help desk", "helpdesk", "chat support", "email support", "client engagement", "client services", "concierge", "technical support representative"]],
  ["Admin & Virtual Assistance", ["virtual assistant", "va ", "executive assistant", "administrative", "admin", "office assistant", "secretary", "receptionist", "clerk", "data entry", "encoder", "transcription", "scheduler", "coordinator", "personal assistant", "back office", "operations assistant", "general assistant", "cyberbacker"]],
  ["Real Estate & Construction", ["real estate", "realtor", "property", "leasing", "broker", "construction", "architect", "civil", "site engineer", "estimator", "surveyor", "town planner", "interior"]],
  ["Engineering & Manufacturing", ["mechanical", "electrical", "electronics", "industrial", "manufacturing", "production", "quality assurance engineer", "quality control", "qc ", "maintenance", "technician", "machinist", "welder", "cad", "plant", "process engineer", "chemical", "automation engineer", "silo"]],
  ["Logistics & Operations", ["logistics", "supply chain", "warehouse", "procurement", "purchasing", "inventory", "dispatcher", "fleet", "driver", "delivery", "shipping", "import", "export", "operations manager", "operations", "planner"]],
  ["Hospitality & Retail", ["hotel", "restaurant", "barista", "bartender", "chef", "cook", "waiter", "waitress", "server", "cashier", "retail", "store", "merchandiser", "housekeeping", "front desk", "guest", "travel", "tour", "food", "kitchen", "crew", "sales associate"]],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A trailing space marks a short token that must match as a whole word
// ("it ", "va ", "hr "); phrases match as substrings; single words match on
// a word boundary at the start so "developer" also catches "developers".
const pattern = (kw: string) => {
  const k = kw.toLowerCase();
  if (k.endsWith(" ")) return `\\b${esc(k.trim())}\\b`;
  if (k.includes(" ") || k.includes("/")) return esc(k);
  return `\\b${esc(k)}`;
};

const COMPILED: Array<[Industry, RegExp]> = RULES.map(([ind, kws]) => [ind, new RegExp(kws.map(pattern).join("|"), "i")]);

/** Best-effort industry for a listing. Title carries most of the signal; company breaks ties. */
export function classifyIndustry(title: string, company = "", extra = ""): Industry {
  const t = ` ${String(title || "")} `.toLowerCase();
  for (const [ind, re] of COMPILED) if (re.test(t)) return ind;
  const rest = ` ${String(company || "")} ${String(extra || "")} `.toLowerCase();
  for (const [ind, re] of COMPILED) if (re.test(rest)) return ind;
  return "Other";
}
