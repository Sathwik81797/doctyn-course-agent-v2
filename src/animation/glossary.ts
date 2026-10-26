/**
 * Short definitions used for "definition" pop-ups. These are general medical-education
 * statements written for this tool, NOT text from the course source, so every pop-up built
 * from them is flagged for clinician review before a slide can be approved.
 */
export interface GlossaryEntry {
  title: string;
  /** Narration phrases (lower case) that trigger the pop-up. */
  terms: string[];
  text: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { title: "Beta cell", terms: ["beta-cell", "beta cell", "β-cell"], text: "Insulin-producing cell of the pancreatic islets. Its secretory reserve decides how long glucose can be kept normal." },
  { title: "Insulin resistance", terms: ["insulin resistance", "insulin-resistance"], text: "Muscle, liver and fat respond poorly to insulin, so more insulin is needed to lower glucose by the same amount." },
  { title: "Compensated insulin resistance", terms: ["compensated insulin resistance"], text: "Insulin resistance in which increased insulin secretion still keeps blood glucose normal." },
  { title: "GLUT4", terms: ["glut-4", "glut4"], text: "Insulin-regulated glucose transporter of muscle and fat. Insulin signalling moves it to the cell surface so glucose can enter." },
  { title: "Gluconeogenesis", terms: ["gluconeogenesis"], text: "Production of new glucose by the liver from non-carbohydrate precursors. It is increased in insulin resistance." },
  { title: "Free fatty acids", terms: ["free fatty acids"], text: "Fats released from adipose tissue. Excess delivery to liver and muscle impairs insulin signalling." },
  { title: "Visceral fat", terms: ["visceral fat"], text: "Fat stored around the abdominal organs. It is metabolically active and linked to insulin resistance independent of BMI." },
  { title: "Portal circulation", terms: ["portal circulation"], text: "Blood from the gut and visceral fat that drains directly to the liver through the portal vein." },
  { title: "Cytokines", terms: ["cytokines"], text: "Inflammatory signalling proteins (for example TNF-alpha and IL-6) that can impair insulin signalling." },
  { title: "HbA1c", terms: ["hba1c"], text: "Glycated haemoglobin. It reflects average blood glucose over roughly the previous three months." },
  { title: "HOMA-IR", terms: ["homa-ir"], text: "An index of insulin resistance calculated from fasting glucose and fasting insulin." },
  { title: "C-peptide", terms: ["c-peptide"], text: "Released in equal amounts with insulin from proinsulin, so it reflects the body's own insulin production." },
  { title: "OGTT", terms: ["oral glucose tolerance test", "ogtt"], text: "Oral glucose tolerance test: plasma glucose is measured while fasting and two hours after a standard glucose load." },
  { title: "Prediabetes", terms: ["prediabetes"], text: "Blood glucose above normal but below the diabetes range, with a high risk of progression to diabetes." },
  { title: "Dysglycaemia", terms: ["dysglycaemia"], text: "Abnormal regulation of blood glucose, covering both prediabetes and diabetes." },
  { title: "Post-prandial", terms: ["post-prandial", "postprandial"], text: "After a meal." },
  { title: "First-phase insulin response", terms: ["first-phase insulin"], text: "The rapid early burst of insulin released after a glucose rise. It is lost early in beta-cell dysfunction." },
  { title: "Gestational diabetes", terms: ["gestational diabetes"], text: "Glucose intolerance first recognised during pregnancy." },
  { title: "PCOS", terms: ["polycystic ovary syndrome", "pcos"], text: "Polycystic ovary syndrome: an endocrine disorder strongly associated with insulin resistance." },
  { title: "Sulfonylurea", terms: ["sulfonylurea"], text: "Oral drug that stimulates insulin release from beta cells, so it depends on remaining beta-cell function." },
  { title: "Metformin", terms: ["metformin"], text: "Oral drug that mainly reduces hepatic glucose production and improves insulin sensitivity." },
  { title: "GAD antibodies", terms: ["gad antibodies"], text: "Autoantibodies against glutamic acid decarboxylase; a marker of autoimmune beta-cell destruction." },
  { title: "Troponin", terms: ["troponin"], text: "Cardiac regulatory protein released into the blood when heart muscle cells are injured; a sensitive marker of myocardial injury." },
  { title: "Ischaemia", terms: ["ischaemia", "ischemia"], text: "Inadequate blood supply to a tissue, so oxygen delivery falls short of demand." },
  { title: "Myocardial infarction", terms: ["myocardial infarction"], text: "Death of heart muscle caused by prolonged ischaemia." },
  { title: "STEMI", terms: ["stemi", "st-elevation myocardial infarction"], text: "ST-elevation myocardial infarction: a myocardial infarction with ST-segment elevation on the ECG." },
  { title: "NSTEMI", terms: ["nstemi", "non-st-elevation myocardial infarction"], text: "Non-ST-elevation myocardial infarction: myocardial infarction without ST-segment elevation on the ECG." },
  { title: "Reperfusion", terms: ["reperfusion"], text: "Restoring blood flow to ischaemic tissue, for example by opening a blocked coronary artery." },
  { title: "Atherosclerosis", terms: ["atherosclerosis", "atherosclerotic"], text: "Build-up of fatty plaque in the walls of arteries, narrowing them over time." },
  { title: "Dyslipidaemia", terms: ["dyslipidaemia", "dyslipidemia"], text: "Abnormal levels of blood lipids such as cholesterol and triglycerides." },
  { title: "Thrombus", terms: ["thrombus"], text: "A blood clot formed inside a blood vessel." },
  { title: "Necrosis", terms: ["necrosis"], text: "Death of cells or tissue caused by injury or loss of blood supply." },
  { title: "Remodelling", terms: ["remodelling", "remodeling"], text: "Gradual change in the size, shape and function of the heart after injury." },
];

export const DRUG_TERMS = ["aspirin", "clopidogrel", "ticagrelor", "heparin", "thrombolysis", "nitrate", "beta-blocker", "ace inhibitor", "metformin", "sulfonylurea", "insulin therapy", "statin", "glp-1", "sglt2", "dpp-4", "pioglitazone"];
