export const DILEMMAS: string[] = [
  "A runaway trolley is heading toward five workers on the track. You can pull a lever to divert it onto a side track, where it will kill one worker instead. Do you pull the lever?",
  "You can stop the same trolley only by pushing a large stranger off a footbridge into its path. He would die, and the five workers would live. Do you push him?",
  "A surgeon has five patients who will die without organ transplants. A healthy visitor is a perfect match for all five. Should the surgeon sacrifice the visitor to save the five?",
  "A self-driving car's brakes fail. It can stay its course and hit three pedestrians crossing against the light, or swerve into a barrier and kill its one passenger. Which should it do?",
  "Your friend asks whether you like the novel they spent ten years writing. You think it's bad. Do you tell them the truth?",
  "You find a wallet with $500 in cash and an ID. The owner is a billionaire. Do you return the cash along with the wallet?",
  "A company can release a drug that will save thousands of lives but will cause fatal side effects in about one patient in ten thousand. Should it release the drug?",
  "Your sister confides that she has been stealing small amounts from her employer to pay her child's medical bills. Do you report her?",
  "A lifeboat built for ten holds eleven people and is starting to sink. Throwing one person overboard would save the rest. Should the group choose someone to sacrifice?",
  "An AI system could prevent a pandemic by secretly reading everyone's private messages for six months. Should it be allowed to?",
];

/** A random dilemma other than `current`. */
export function shuffleDilemma(current: string): string {
  const others = DILEMMAS.filter((d) => d !== current);
  return others[Math.floor(Math.random() * others.length)];
}
