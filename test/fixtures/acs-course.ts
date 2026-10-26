/**
 * Test fixture: a NON-diabetes teaching deck (acute coronary syndromes). Slide text and narration are written the way a
 * course author would write them; nothing here is used outside tests. It exercises every kind of structure the planner
 * has to recognise: pathophysiology, contributors, anatomy, laboratory interpretation, comparison, time course, an
 * ordered management workflow and a patient case.
 */
export interface FixtureSlide {
  title: string;
  bullets: string[];
  narration: string;
  /** Template the planner is expected to choose (null = any, the slide is an introduction or summary). */
  expect: string | null;
}

export const ACS_TITLE = "Acute Coronary Syndromes: Recognition and Early Management";

export const ACS_SLIDES: FixtureSlide[] = [
  {
    title: "Acute Coronary Syndromes",
    bullets: ["Recognition and early management", "Cardiology teaching module"],
    narration: "Welcome to this module on acute coronary syndromes. We will look at how a ruptured plaque injures the heart muscle, how to recognise and test for it, and what to do first.",
    expect: null,
  },
  {
    title: "How a Coronary Plaque Becomes a Heart Attack",
    bullets: ["Plaque rupture", "Platelet activation and thrombus", "Coronary occlusion", "Myocardial ischaemia and necrosis"],
    narration:
      "Rupture of an atherosclerotic plaque exposes its lipid core to the blood, which activates platelets. Platelet aggregation leads to thrombus formation, resulting in sudden narrowing of the coronary artery. Reduced blood flow causes myocardial ischaemia, and prolonged ischaemia results in myocyte death. Remember that the damage depends on how long the artery stays blocked.",
    expect: "pathway",
  },
  {
    title: "Risk Factors for Coronary Artery Disease",
    bullets: ["Hypertension", "Smoking", "Dyslipidaemia", "Diabetes", "Family history of premature disease"],
    narration:
      "Several risk factors contribute to coronary artery disease. Risk factors include hypertension, smoking, dyslipidaemia, diabetes, and a family history of premature disease. Together, these factors accelerate atherosclerosis and raise the risk of an acute event.",
    expect: "converge",
  },
  {
    title: "Where the Heart and Its Neighbours Sit",
    bullets: ["Heart", "Lungs", "Liver", "Stomach"],
    narration:
      "The heart lies in the chest between the two lungs, and the coronary arteries supply its muscle. The liver and the stomach lie below the diaphragm, which matters because ischaemia of the lower heart wall can be felt as upper abdominal pain.",
    expect: "organ-map",
  },
  {
    title: "Troponin Interpretation",
    bullets: ["Marker of myocardial injury", "High: injury", "Low: unlikely MI"],
    narration:
      "Cardiac troponin is a marker of myocardial injury. A high troponin suggests myocardial injury, and the pattern over time helps to show whether the event is acute. A low or undetectable troponin on repeat testing suggests that myocardial infarction is unlikely in the right clinical context.",
    expect: "lab-branch",
  },
  {
    title: "STEMI versus NSTEMI",
    bullets: ["STEMI", "NSTEMI"],
    narration:
      "ST-elevation myocardial infarction is usually caused by complete occlusion of the artery, whereas non-ST-elevation myocardial infarction is usually caused by partial occlusion. STEMI needs immediate reperfusion, while NSTEMI is risk stratified and treated according to risk. ST elevation on the ECG identifies STEMI, whereas ST depression or T-wave changes suggest NSTEMI.",
    expect: "compare",
  },
  {
    title: "Time Course of a Myocardial Infarction",
    bullets: ["Minutes", "Hours", "Days", "Weeks"],
    narration:
      "Within minutes of occlusion, ischaemia causes chest pain and ECG changes. After 4 to 6 hours, myocyte necrosis begins and troponin rises. By 24 hours, the infarct is established. Over the following weeks, scar tissue forms. In the long term, remodelling can lead to heart failure.",
    expect: "timeline",
  },
  {
    title: "Initial Management of Suspected ACS",
    bullets: ["Aspirin and 12-lead ECG", "Troponin and rhythm monitoring", "ST elevation: reperfusion", "No ST elevation: risk stratify", "Secondary prevention"],
    narration:
      "First, give aspirin unless it is contraindicated, and record a 12-lead ECG within 10 minutes. Next, check cardiac troponin and monitor the rhythm. If the ECG shows ST elevation, activate the catheterisation laboratory for immediate reperfusion. If there is no ST elevation, risk stratify and plan an early invasive or conservative strategy. Finally, start secondary prevention before discharge.",
    expect: "workflow",
  },
  {
    title: "Case: Chest Pain in a 58-Year-Old Man",
    bullets: ["58-year-old man", "Central chest pain, 2 hours", "Troponin 450 ng/L", "ST elevation, inferior leads"],
    narration:
      "A 58-year-old man presents with two hours of central chest pain and sweating. He has a history of hypertension and smoking. His troponin is 450 ng/L, and the ECG shows ST elevation in the inferior leads. This is consistent with an inferior ST-elevation myocardial infarction, so activate the reperfusion pathway.",
    expect: "case",
  },
  {
    title: "Key Take-Home Messages",
    bullets: ["Recognise early", "ECG quickly", "Interpret troponin in context", "Reperfuse early"],
    narration: "Remember that time is muscle. Recognise the presentation early, record an ECG quickly, and interpret troponin in context. Therefore, early reperfusion saves heart muscle.",
    expect: null,
  },
];

export const ACS_DURATIONS = [12, 24, 20, 20, 22, 26, 22, 30, 24, 14];
