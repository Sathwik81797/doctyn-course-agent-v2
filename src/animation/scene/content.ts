/**
 * Authored scene content for "Risk Factors for Diabetes – From Genetics to Lifestyle".
 *
 * Every on-screen string is taken from that slide's own text or narration (nothing new is claimed);
 * what the scene adds is visual structure. Cues are phrases from the narration that trigger each
 * element, so the diagram builds in step with the voice. All labels are editable in the studio and
 * any change sends the slide back to "needs review".
 *
 * Entries only apply when the slide title matches, so a different course with the same slide
 * numbers never picks them up. Pure data: shared by the Node renderer and the browser studio.
 */
import type { TemplateId } from "../types.js";

export interface Item {
  id: string;
  /** Default on-screen text. "Head|sub" splits into a heading and a sub-line. */
  label: string;
  /** Narration phrases that trigger the element, in order of preference. */
  cues: string[];
  /** Appears from its cue alone instead of chaining after the previous item. */
  free?: boolean;
  /** Fraction of the narration at which it appears when no cue is found. */
  frac?: number;
  description?: string;
}

export interface Authored {
  /** The slide title must match, so the content cannot leak onto another course. */
  match: RegExp;
  template: TemplateId;
  params?: Record<string, string | number | boolean>;
  items: Item[];
  /** Slide-specific points the clinician must look at before approving. */
  flags?: string[];
}

const it = (id: string, label: string, cues: string[], more: Partial<Item> = {}): Item => ({ id, label, cues, ...more });

type CaseLine = [label: string, cue: string];
type CasePanel = [kind: string, title: string, titleCue: string, lines: CaseLine[]];

/** Case board: each panel is a title element followed by its lines. */
function casePanels(match: RegExp, build: "lean" | "average" | "obese", panels: CasePanel[], flags: string[] = []): Authored {
  const items: Item[] = [];
  const params: Record<string, string | number | boolean> = { build, panels: panels.length };
  panels.forEach(([kind, title, titleCue, lines], i) => {
    const p = `p${i + 1}`;
    params[`${p}.kind`] = kind;
    items.push(it(p, title, titleCue ? [titleCue] : [], { description: `Panel: ${title}` }));
    lines.forEach(([label, cue], j) => items.push(it(`${p}.l${j + 1}`, label, [cue], { description: `${title}: ${label}` })));
  });
  return { match, template: "case", params, items, flags };
}

const ALGO = "Algorithm rail: the deck shows Steps 1, 2, 4, 5 and 6; the step-3 label on slide 48 is inferred because it points on to Step 4.";

export const AUTHORED: Record<number, Authored> = {
  // ---- opening ----
  1: {
    match: /risk factors for diabetes/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "Genetics", ["genetic susceptibility"]),
      it("n2", "Body composition", ["body composition"]),
      it("n3", "Lifestyle|Physical activity · diet", ["physical activity"]),
      it("n4", "Metabolic risk", ["metabolic factors"]),
      it("note", "A clinical approach to metabolic vulnerability, phenotype and early risk recognition", ["recognize metabolic vulnerability"], { free: true }),
    ],
  },
  2: {
    match: /why risk factor assessment/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "Diabetes is progressive|Not an on/off disease — it evolves over many years", ["on-and-off disease"]),
      it("n2", "β-cell loss|By fasting glucose ≥126 mg/dL, about half of β-cell function may be lost", ["fasting glucose crosses"]),
      it("n3", "Early injury|Microvascular injury and cardiovascular risk may already be present", ["microvascular injury"]),
      it("n4", "Why assess risk?|Identify vulnerability · detect early changes · intervene before irreversible β-cell loss", ["risk-factor assessment"]),
      it("stat", "50%", ["50 percent"], { free: true, description: "Ring: share of β-cell function lost" }),
      it("statCap", "of β-cell function may already be lost", ["may already be lost"], { free: true }),
    ],
    flags: ["The 50 % ring only visualises the figure stated in the source (β-cell function lost by fasting glucose ≥126 mg/dL)."],
  },
  // ---- two axes ----
  4: {
    match: /two biological axes/i,
    template: "balance",
    params: { tilt: "left" },
    items: [
      it("L", "Insulin resistance", ["insulin resistance"], { free: true }),
      it("R", "β-cell reserve", ["beta-cell reserve"], { free: true }),
      it("l1", "Muscle", ["the muscle"], { free: true }),
      it("l2", "Liver", ["liver"], { free: true }),
      it("l3", "Adipose tissue", ["adipose tissue"], { free: true }),
      it("r1", "Ability of the pancreas to compensate", ["ability of the pancreas"], { free: true }),
      it("verdict", "Diabetes develops when insulin resistance exceeds β-cell capacity", ["exceeds the capacity"], { free: true }),
    ],
  },
  5: {
    match: /clinical meaning of risk factors/i,
    template: "balance",
    params: { tilt: "level" },
    items: [
      it("head", "Risk factors are not equal", ["not equal"], { free: true }),
      it("L", "Insulin-resistance dominance", ["insulin-resistance dominance"], { free: true }),
      it("l1", "Obese", ["obesity"], { free: true }),
      it("l2", "Sedentary", ["sedentary behaviour"], { free: true }),
      it("R", "β-cell vulnerability", ["beta-cell vulnerability"], { free: true }),
      it("r1", "Family history", ["family history"], { free: true }),
      it("r2", "Lean Indian phenotype", ["lean indian phenotype"], { free: true }),
      it("r3", "GDM", ["gestational diabetes"], { free: true }),
      it("r4", "LADA", ["lada"], { free: true }),
      it("verdict", "Interpretation → test selection → phenotype → intervention", ["correct interpretation"], { free: true }),
    ],
  },
  // ---- age, genetics, phenotype ----
  6: {
    match: /how age increases/i,
    template: "converge",
    items: [
      it("s1", "β-cell replication|Declines", ["beta-cell replication"], { free: true }),
      it("s2", "Mitochondrial function|Dysfunction", ["mitochondrial dysfunction"], { free: true }),
      it("s3", "Oxidative stress|Increases", ["oxidative stress"], { free: true }),
      it("s4", "Insulin secretion|Reduced response", ["insulin secretory response"], { free: true }),
      it("out", "Older adults|Tolerate metabolic stress poorly and progress faster", ["older adults"], { free: true }),
    ],
  },
  7: {
    match: /young age of onset/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "Strong genetic load", ["strong genetic load"]),
      it("n2", "Early β-cell vulnerability", ["early beta-cell vulnerability"]),
      it("n3", "Higher lifetime complication burden", ["higher lifetime complication"]),
      it("note", "Young dysglycaemia should never be dismissed", ["never be dismissed"], { free: true }),
    ],
  },
  8: {
    match: /south asian/i,
    template: "body",
    params: { lean: false, "c1.region": "abdomen", "c2.region": "muscle", "c3.region": "liver", "c4.region": "tissue", "c5.region": "pancreas" },
    items: [
      it("c1", "Visceral fat|Higher at a lower BMI", ["higher visceral fat"], { free: true }),
      it("c2", "Muscle|Lower skeletal muscle mass", ["lower skeletal muscle mass"], { free: true }),
      it("c3", "Liver|Higher hepatic fat", ["higher hepatic fat"], { free: true }),
      it("c4", "Early insulin resistance", ["early insulin resistance"], { free: true }),
      it("c5", "β-cell|Limited β-cell reserve", ["limited beta-cell reserve"], { free: true }),
      it("note", "Result: diabetes develops at a lower BMI and a younger age", ["as a result"], { free: true }),
    ],
    flags: ["Body outline and organ positions are schematic; the call-outs repeat the slide's wording."],
  },
  9: {
    match: /clinical consequence/i,
    template: "body",
    params: { lean: true, "c1.region": "whole", "c2.region": "alert", "c3.region": "pancreas", "c4.region": "trend" },
    items: [
      it("c1", "Lean Indian patient + hyperglycaemia", ["lean indian patient"], { free: true }),
      it("c2", "Not automatically “mild diabetes”", ["mild diabetes"], { free: true }),
      it("c3", "Likely significant β-cell dysfunction", ["significant beta-cell dysfunction"], { free: true }),
      it("c4", "May progress rapidly", ["progress rapidly"], { free: true }),
      it("note", "Clinical phenotype matters — not body weight alone", ["clinical phenotype"], { free: true }),
    ],
    flags: ["Body outline and organ positions are schematic."],
  },
  10: {
    match: /family history truly/i,
    template: "converge",
    items: [
      it("s1", "Polygenic inheritance", ["polygenic inheritance"], { free: true }),
      it("s2", "Shared dietary habits", ["shared dietary habits"], { free: true }),
      it("s3", "Shared activity patterns", ["shared activity patterns"], { free: true }),
      it("s4", "Epigenetic programming", ["epigenetic programming"], { free: true }),
      it("out", "Lower threshold for disease|A stronger family history should increase clinical vigilance", ["lowers the threshold"], { free: true }),
    ],
  },
  11: {
    match: /laboratory clue/i,
    template: "converge",
    items: [
      it("s1", "First-phase response|Early loss", ["first-phase insulin response"], { free: true }),
      it("s2", "Fasting C-peptide|Lower for a given glucose", ["lower fasting c-peptide"], { free: true }),
      it("s3", "Post-prandial glucose|Rapid rise", ["rapid rise"], { free: true }),
      it("out", "Genetic β-cell weakness|These changes can occur before fasting glucose rises", ["before fasting glucose rises"], { free: true }),
    ],
  },
  13: {
    match: /clinical measurement/i,
    template: "body",
    params: { lean: false, "c1.region": "scale", "c2.region": "waist" },
    items: [
      it("c1", "BMI|Always record", ["bmi"], { free: true }),
      it("c2", "Waist circumference|Always record", ["waist circumference"], { free: true }),
      it("note", "Normal BMI + high waist = high metabolic risk", ["high-risk metabolic pattern"], { free: true }),
    ],
    flags: ["The tape-measure and scale are schematic; no reference values are drawn."],
  },
  15: {
    match: /low muscle mass/i,
    template: "converge",
    items: [
      it("s1", "Elderly", ["elderly individuals"], { free: true }),
      it("s2", "Sedentary individuals", ["sedentary individuals"], { free: true }),
      it("s3", "Chronic illness", ["chronic illness"], { free: true }),
      it("s4", "Malnutrition", ["malnutrition"], { free: true }),
      it("out", "Low muscle mass|Diabetes can develop even without obesity", ["even without obesity"], { free: true }),
    ],
  },
  17: {
    match: /dietary pattern/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "High glycaemic-load diet", ["high-glycaemic-load"]),
      it("n2", "Repeated insulin spikes", ["repeated insulin spikes"]),
      it("n3", "β-cell exhaustion", ["beta-cell exhaustion"]),
      it("n4", "Earlier failure", ["earlier failure"]),
      it("note", "Quality of carbohydrate matters more than quantity", ["quality of carbohydrate"], { free: true }),
    ],
  },
  18: {
    match: /^prediabetes$/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("stat", "5–10%", ["5 to 10 percent"], { free: true }),
      it("statCap", "annual diabetes conversion", ["annual diabetes conversion"], { free: true }),
      it("n1", "Insulin resistance|Existing metabolic abnormality", ["existing insulin resistance"], { free: true }),
      it("n2", "β-cell dysfunction|Already present in the source framework", ["beta-cell dysfunction"]),
      it("n3", "Established metabolic disease|Not an insignificant finding", ["established metabolic disease"]),
    ],
  },
  19: {
    match: /gestational diabetes: a long-term/i,
    template: "timeline",
    items: [
      it("m1", "Pregnancy|Insulin resistance rises; GDM may reveal limited β-cell reserve", ["pregnancy increases insulin resistance"], { free: true }),
      it("risk", "Future diabetes risk remains elevated", ["risk remains elevated"], { free: true }),
      it("m2", "4–12 weeks postpartum|75-g oral glucose tolerance test", ["75-gram oral glucose tolerance test"], { free: true }),
      it("m3", "Lifelong|If normal: screen every 1–3 years", ["lifelong screening"], { free: true }),
      it("m4", "Ongoing|Lifestyle and cardiometabolic risk management", ["ongoing lifestyle"], { free: true }),
      it("note", "GDM is not only a pregnancy diagnosis — it is a long-term metabolic risk marker", ["is not only a pregnancy diagnosis"], { free: true }),
    ],
    flags: ["Timeline positions are schematic; the intervals (4–12 weeks, every 1–3 years) are the source's wording."],
  },
  20: {
    match: /^gestational diabetes$/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "Pregnancy stress", ["stress of pregnancy"]),
      it("n2", "Limited β-cell reserve|Unmasked", ["limited beta-cell reserve"]),
      it("n3", "Type 2 diabetes|Future risk", ["develop type 2 diabetes"]),
      it("stat", "40–60%", ["40 to 60 percent"], { free: true }),
      it("statCap", "develop T2DM within 10 years", ["within 10 years"], { free: true }),
    ],
  },
  21: {
    match: /^pcos$/i,
    template: "pathway",
    params: { escalate: true },
    items: [
      it("n1", "PCOS|Polycystic ovary syndrome", ["polycystic ovary syndrome"]),
      it("n2", "Insulin-resistance state", ["insulin-resistance state"]),
      it("n3", "High lifetime diabetes risk", ["high lifetime diabetes risk"]),
      it("n4", "Screen early", ["screened early"]),
    ],
  },
  // ---- investigations ----
  22: {
    match: /core screening tests/i,
    template: "converge",
    items: [
      it("s1", "Fasting plasma glucose", ["fasting plasma glucose"], { free: true }),
      it("s2", "HbA1c", ["hba1c"], { free: true }),
      it("s3", "OGTT|If there is diagnostic doubt", ["oral glucose tolerance test"], { free: true }),
      it("out", "Detect dysglycaemia|Not the underlying metabolic biology", ["detect dysglycaemia"], { free: true }),
    ],
  },
  23: {
    match: /^fasting insulin$/i,
    template: "lab-branch",
    items: [
      it("test", "Fasting insulin", ["fasting insulin"], { free: true }),
      it("what", "Reflects the degree of insulin secretion", ["degree of insulin secretion"], { free: true }),
      it("hi", "High fasting insulin|Suggests insulin resistance", ["a high fasting insulin"], { free: true }),
      it("lo", "Low / normal insulin + hyperglycaemia|Suggests β-cell failure", ["low or normal fasting insulin"], { free: true }),
    ],
    flags: ["Gauge needle is a visual metaphor for 'high' versus 'low / normal'; no numeric scale is drawn."],
  },
  24: {
    match: /homa-ir/i,
    template: "homa",
    items: [
      it("glucose", "Fasting glucose", ["fasting glucose"], { free: true }),
      it("insulin", "Fasting insulin", ["fasting insulin"], { free: true }),
      it("den", "405", ["divided by 405"], { free: true }),
      it("result", "HOMA-IR|Insulin resistance index", [], { free: true, frac: 0.42 }),
      it("m2", "2|Insulin resistance", ["a value of 2"], { free: true }),
      it("m3", "3|Significant insulin resistance", ["a value of 3"], { free: true }),
      it("note", "Useful in early disease", ["useful in early disease"], { free: true }),
    ],
    flags: ["Formula and the thresholds 2 and 3 are as printed on the slide; confirm the units convention (denominator 405) for the audience."],
  },
  25: {
    match: /^c-peptide$/i,
    template: "lab-branch",
    items: [
      it("test", "C-peptide", ["c-peptide"], { free: true }),
      it("what", "Reflects endogenous insulin production", ["endogenous insulin production"], { free: true }),
      it("hi", "Normal / high|Preserved β-cell function", ["normal or high c-peptide"], { free: true }),
      it("lo", "Low|β-cell failure", ["a low c-peptide"], { free: true }),
      it("note", "Interpret alongside the glucose level", ["alongside the glucose"], { free: true }),
    ],
    flags: ["Gauge needle is a visual metaphor; no numeric scale is drawn."],
  },
  26: {
    match: /ogtt pattern/i,
    template: "ogtt",
    items: [
      it("p1", "2-h ↑ + fasting normal|Muscle insulin resistance", ["elevated two-hour glucose"], { free: true }),
      it("p2", "Fasting ↑|Hepatic insulin resistance", ["an elevated fasting glucose"], { free: true }),
      it("p3", "Fasting ↑ + 2-h ↑|Advanced disease", ["when both fasting"], { free: true }),
      it("note", "Use the pattern to think about the dominant site of metabolic dysfunction", [], { free: true, frac: 0.9 }),
    ],
    flags: ["Panels mark only the glucose readings the slide names (fasting and/or 2-h); the height of each point is illustrative, not patient data."],
  },
  27: {
    match: /investigations summary/i,
    template: "stagemap",
    params: { "st1.col": 0, "st1.row": 0, "st2.col": 1, "st2.row": 0, "st3.col": 1, "st3.row": 1, "st4.col": 2, "st4.row": 1 },
    items: [
      it("st1", "Normal glucose + high insulin|Compensated insulin resistance", ["normal glucose with high insulin"], { free: true }),
      it("st2", "Prediabetes + high insulin|Insulin-resistance-dominant stage", ["prediabetes with high insulin"], { free: true }),
      it("st3", "Prediabetes + low C-peptide|β-cell-dominant stage", ["prediabetes with low c-peptide"], { free: true }),
      it("st4", "Diabetes + low C-peptide|Advanced β-cell failure", ["diabetes with low c-peptide"], { free: true }),
    ],
    flags: ["The grid places each finding by glucose status (columns) and insulin / C-peptide level (rows) exactly as listed on the slide."],
  },
  // ---- phenotypes ----
  28: {
    match: /insulin-resistance dominant phenotype/i,
    template: "converge",
    items: [
      it("s1", "Obese", ["obesity"], { free: true }),
      it("s2", "High fasting insulin", ["high fasting insulin"], { free: true }),
      it("s3", "High HOMA-IR", ["high homa-ir"], { free: true }),
      it("s4", "High C-peptide", ["high c-peptide"], { free: true }),
      it("out", "Insulin-resistance-dominant phenotype|Per the source: responds well to lifestyle modification + metformin", ["respond well"], { free: true }),
    ],
  },
  29: {
    match: /cell failure dominant phenotype/i,
    template: "converge",
    items: [
      it("s1", "Lean phenotype", ["lean phenotype"], { free: true }),
      it("s2", "Family history", ["family history"], { free: true }),
      it("s3", "Low C-peptide", ["low c-peptide"], { free: true }),
      it("out", "β-cell-failure-dominant phenotype|May progress rapidly; often require early insulin", ["progress rapidly"], { free: true }),
    ],
  },
  // ---- cases ----
  30: casePanels(/young lean patient/i, "lean", [
    ["profile", "Patient profile", "this patient", [["Age: 24 years", "24 years old"], ["BMI: 21 kg/m²", "bmi of 21"], ["HbA1c: 6.2%", "hba1c of 6.2"]]],
    ["labs", "Lab clues", "", [["Fasting insulin: low-normal", "fasting insulin is low-normal"], ["C-peptide: low-normal", "c-peptide is low-normal"]]],
    ["interp", "Interpretation", "the interpretation", [["Early β-cell failure", "early beta-cell failure"], ["Consider LADA", "lada"]]],
  ]),
  31: casePanels(/obese middle-aged/i, "obese", [
    ["profile", "Patient", "this patient", [["Age: 48 years", "48 years old"], ["BMI: 31", "bmi of 31"], ["HbA1c: 6.4%", "hba1c of 6.4"]]],
    ["labs", "Labs", "", [["Fasting insulin: HIGH", "fasting insulin"], ["HOMA-IR: HIGH", "homa-ir"], ["C-peptide: NORMAL", "c-peptide is normal"]]],
    ["interp", "Interpretation", "the clinical interpretation", [["Insulin-resistance-dominant prediabetes", "insulin-resistance-dominant prediabetes"]]],
  ]),
  32: casePanels(/woman with history of gdm/i, "average", [
    ["profile", "Patient profile", "this is a", [["32-year-old female", "32-year-old woman"], ["BMI: 24 kg/m²", "bmi of 24"], ["Waist circumference: 88 cm", "waist circumference of 88"]]],
    ["history", "History", "", [["Gestational diabetes 4 years ago", "gestational diabetes four years ago"], ["Currently asymptomatic", "asymptomatic"], ["No known diabetes", "no known diabetes"]]],
  ]),
  33: casePanels(/initial evaluation/i, "average", [
    ["alert", "High risk because of prior GDM", "considered high risk", []],
    ["plan", "Order", "the first tests", [["Fasting plasma glucose", "fasting plasma glucose"], ["HbA1c", "hba1c"]]],
    ["labs", "Results", "the results are", [["FBS: 108 mg/dL", "fasting blood sugar of 108"], ["HbA1c: 6.0%", "hba1c of 6.0"]]],
  ]),
  34: casePanels(/^interpretation$/i, "average", [
    ["interp", "Prediabetes present", "show prediabetes", [["Existing insulin resistance + limited β-cell reserve", "existing insulin resistance"]]],
    ["plan", "Next tests", "next tests", [["Fasting insulin", "fasting insulin"], ["C-peptide", "c-peptide"]]],
  ]),
  35: casePanels(/advanced results/i, "average", [
    ["labs", "Advanced results", "advanced results", [["Fasting insulin: 18 µIU/mL HIGH", "fasting insulin of 18"], ["C-peptide: NORMAL", "normal c-peptide"]]],
  ]),
  36: casePanels(/clinical conclusion/i, "average", [
    ["interp", "Overall interpretation", "overall interpretation", [["Prediabetes", "prediabetes"], ["Insulin-resistance-dominant phenotype", "insulin-resistance-dominant phenotype"]]],
    ["alert", "Outlook", "", [["High likelihood of progression without intervention", "high likelihood"]]],
  ]),
  37: casePanels(/management implication/i, "average", [
    ["plan", "Management", "management implication", [["Intensive lifestyle intervention", "intensive lifestyle intervention"], ["Consider metformin", "metformin"], ["Annual monitoring", "annual monitoring"], ["Goal: interrupt progression early", ""]]],
  ]),
  38: casePanels(/case 4/i, "lean", [
    ["profile", "Patient profile", "this is a", [["35-year-old male", "35-year-old man"], ["BMI: 22 kg/m²", "bmi of 22"], ["Diabetes diagnosed 8 months ago", "eight months ago"]]],
    ["plan", "Treatment", "taking", [["Metformin + sulfonylurea", "metformin plus a sulfonylurea"]]],
    ["alert", "Problem", "despite treatment", [["HbA1c remains 9.2%", "hba1c remains 9.2"]]],
  ]),
  39: casePanels(/clinical concern/i, "lean", [
    ["alert", "Clinical concern", "", [["Lean", "lean"], ["Poor response to oral agents", "poor response to oral agents"], ["Early failure", "early failure"]]],
    ["interp", "Suspicion", "raise suspicion", [["Suspect β-cell failure / LADA", "beta-cell failure"]]],
  ]),
  40: casePanels(/investigations ordered/i, "average", [
    ["plan", "Investigations", "order c-peptide", [["C-peptide", "order c-peptide"], ["GAD antibodies", "gad antibodies"]]],
    ["labs", "Results", "the results show", [["C-peptide: LOW", "low c-peptide"], ["GAD antibodies: POSITIVE", "positive gad antibodies"]]],
    ["interp", "Conclusion", "the clinical conclusion", [["LADA", "is lada"], ["Autoimmune β-cell destruction", "representing autoimmune"]]],
  ]),
  41: casePanels(/management implication/i, "lean", [
    ["plan", "Management", "management implications", [["Stop: sulfonylurea", "stop the sulfonylurea"], ["Start: insulin early", "start insulin early"], ["Counsel: patient", "counsel the patient"]]],
  ], ["Treatment instructions (stop / start) are taken verbatim from the slide; the ✕ / ✓ icons only mirror those verbs."]),
  42: casePanels(/obese patient with normal glucose/i, "obese", [
    ["profile", "Patient profile", "this is a", [["42-year-old female", "42-year-old woman"], ["BMI: 34 kg/m²", "bmi of 34"], ["Waist: 104 cm", "waist circumference of 104"]]],
    ["labs", "Glycaemia", "her fasting", [["FBS: 94 mg/dL", "fasting blood sugar is 94"], ["HbA1c: 5.4%", "hba1c is 5.4"]]],
  ]),
  43: casePanels(/why this patient is not/i, "obese", [
    ["interp", "Clinical pattern", "this patient has", [["Marked obesity + central adiposity", "marked obesity"]]],
    ["plan", "Tests", "next tests", [["Fasting insulin", "fasting insulin"], ["HOMA-IR", "homa-ir"]]],
    ["labs", "Results", "the results are", [["Fasting insulin: 28 µIU/mL", "fasting insulin of 28"], ["HOMA-IR: 6.2", "homa-ir of 6.2"]]],
    ["alert", "Source note: AHA waist risk", "american heart association", [["> 94 cm (37 in) in men", "over 94 centimetres"], ["> 80 cm (31.5 in) in women", "over 80 centimetres"]]],
  ], ["Waist thresholds are quoted from the slide's source note (AHA); confirm they are appropriate for this audience."]),
  44: casePanels(/^interpretation$/i, "obese", [
    ["interp", "Interpretation", "the interpretation", [["Severe insulin resistance", "severe insulin resistance"], ["with compensated β-cell function", "compensated beta-cell function"]]],
    ["alert", "Trajectory", "prediabetes is not", [["Prediabetes not yet present", "not yet present"], ["Trajectory is toward diabetes", "toward diabetes"]]],
  ]),
  45: casePanels(/management implication/i, "obese", [
    ["plan", "Management", "management approach", [["Aggressive lifestyle intervention", "aggressive lifestyle intervention"], ["Weight-loss programme", "weight-loss programme"], ["Repeat glycaemic testing in 6 months", "repeat glycaemic testing"], ["Monitor the trajectory — not just today's glucose", ""]]],
  ]),
  // ---- algorithm ----
  46: {
    match: /algorithm: test ordering/i,
    template: "algorithm",
    params: { step: 1, cols: 3 },
    items: [
      it("head", "Identify the high-risk patient", ["identify the high-risk patient"], { free: true }),
      it("d1", "BMI ≥23 (Indians)", ["bmi of at least 23"], { free: true }),
      it("d2", "High waist circumference", ["high waist circumference"], { free: true }),
      it("d3", "Family history", ["family history"], { free: true }),
      it("d4", "GDM / PCOS", ["gestational diabetes or pcos"], { free: true }),
      it("d5", "Hypertension / dyslipidaemia", ["hypertension or dyslipidaemia"], { free: true }),
      it("d6", "Steroid or antipsychotic use", ["steroid or antipsychotic"], { free: true }),
      it("note", "High risk if ANY are present", ["presence of any"], { free: true }),
    ],
    flags: [ALGO],
  },
  47: {
    match: /step 2/i,
    template: "algorithm",
    params: { step: 2, cols: 2 },
    items: [
      it("head", "First-line evaluation", ["first-line evaluation"], { free: true }),
      it("d1", "Fasting plasma glucose", ["fasting plasma glucose"], { free: true }),
      it("d2", "HbA1c", ["hba1c"], { free: true }),
    ],
    flags: [ALGO],
  },
  48: {
    match: /interpret results/i,
    template: "algorithm",
    params: { step: 3, cols: 2 },
    items: [
      it("head", "Interpret the results", ["if the results are normal"], { free: true }),
      it("d1", "Normal results|High-risk phenotype", ["results are normal"], { free: true }),
      it("d2", "Prediabetes / diabetes", ["prediabetes or diabetes"], { free: true }),
      it("next", "Proceed to Step 4", [], { frac: 0.78 }),
    ],
    flags: [ALGO],
  },
  49: {
    match: /step 4/i,
    template: "algorithm",
    params: { step: 4, cols: 3 },
    items: [
      it("head", "Identify the underlying mechanism", ["at this stage"], { free: true }),
      it("d1", "Fasting insulin", ["fasting insulin"], { free: true }),
      it("d2", "C-peptide", ["c-peptide"], { free: true }),
      it("d3", "OGTT|Consider", ["oral glucose tolerance test"], { free: true }),
      it("note", "Goal: identify the underlying mechanism", ["underlying mechanism"], { free: true }),
    ],
    flags: [ALGO],
  },
  50: {
    match: /step 5/i,
    template: "algorithm",
    params: { step: 5, cols: 2 },
    items: [
      it("head", "Classify the phenotype", ["high insulin with normal"], { free: true }),
      it("d1", "High insulin + normal / high C-peptide|Insulin-resistance-dominant phenotype", ["high insulin with normal"], { free: true }),
      it("d2", "Normal / low insulin + low C-peptide|β-cell-failure-dominant phenotype", ["normal or low insulin"], { free: true }),
    ],
    flags: [ALGO],
  },
  51: {
    match: /step 6/i,
    template: "algorithm",
    params: { step: 6, cols: 3 },
    items: [
      it("head", "Act on the phenotype", ["management is based"], { free: true }),
      it("d1", "Insulin-resistance dominant|Lifestyle modification + metformin", ["insulin-resistance-dominant phenotype"], { free: true }),
      it("d2", "β-cell dominant|Early insulin", ["beta-cell-dominant phenotype"], { free: true }),
      it("d3", "Mixed phenotype|Combination approach", ["mixed phenotype"], { free: true }),
    ],
    flags: [ALGO],
  },
  52: {
    match: /take-home messages/i,
    template: "converge",
    items: [
      it("s1", "Risk reflects underlying biology, not just weight", ["reflects underlying biology"], { free: true }),
      it("s2", "Lean patients can have severe disease", ["lean patients"], { free: true }),
      it("s3", "Early labs can identify the disease mechanism", ["early laboratory testing"], { free: true }),
      it("s4", "Mechanism-based therapy improves outcomes", ["mechanism-based therapy"], { free: true }),
      it("out", "Understand the biology → recognize the phenotype → act early", [], { free: true, frac: 0.93 }),
    ],
  },
};

/** The authored content for a slide, only when its title matches this course. */
export function authoredFor(slide: number, title: string): Authored | undefined {
  const a = AUTHORED[slide];
  return a && a.match.test(title) ? a : undefined;
}

/** Visual devices a clinician should know are template-supplied rather than source content. */
export const TEMPLATE_ASSUMPTIONS: Partial<Record<TemplateId, string>> = {
  pathway: "The arrows and the colour escalation are a visual device linking the slide's own phrases; they are not an added causal claim.",
  converge: "The arrows show the listed items feeding the stated conclusion; they illustrate the slide's wording, not additional mechanism.",
  balance: "The tilting scale is a metaphor for insulin resistance versus β-cell capacity.",
  body: "The body outline and organ positions are schematic.",
  "lab-branch": "The gauge needle is a metaphor for high versus low; no numeric scale is shown.",
  homa: "Marker positions on the scale are schematic; only the values 2 and 3 are from the slide.",
  ogtt: "The glucose curves are illustrative, not patient data.",
  stagemap: "The grid arranges the slide's four findings by glucose status and insulin / C-peptide level.",
  timeline: "Timeline spacing is schematic.",
  case: "The patient figure is a generic body-build icon; lab values are shown exactly as written on the slide, with no added reference ranges.",
  algorithm: "The six-step rail is built from the deck's own step titles.",
};
