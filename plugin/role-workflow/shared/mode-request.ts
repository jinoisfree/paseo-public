/** Only a direct choice or an imperative at the start of the message changes intent. */
export function requestedMode(text: string): "general" | "federated" | null {
  const first = text
    .trim()
    .split(/\n|[.!。]/, 1)[0]
    .trim()
    .replace(/^(?:아니[,]?\s+|그냥\s+)/, "");
  if (
    /^연합개발(?:로)?\s*(?:전환|진행|시작)?\s*(?:하지\s*(?:마(?:세요)?|말아(?:줘|주세요)?|말고\s*일반개발로\s*(?:해|진행해)(?:줘|주세요)?)|취소(?:해|해줘|해\s*주세요)?)(?:요)?$/.test(
      first,
    )
  )
    return "general";
  const match =
    /^(일반개발|연합개발)(?:\s*(?:로|으로)\s*(?:진행|전환|시작|변경|바꿔|해|하)[^]*)?$/.exec(first);
  if (!match) return null;
  const rest = first.slice(match[1].length);
  // Questions, comparisons, quotations and negations are not choices.
  if (
    /[?？"'“”‘’`]|말[고아]|말아|않|아니|금지|취소|고민|할까|할지|하면|하는|하려면|설명|비교/.test(
      rest,
    )
  )
    return null;
  if (
    rest &&
    !/(?:해\s*줘|해\s*주세요|해|하자|한다|하세요|할게|할게요|하겠습니다|바꿔\s*줘|바꿔\s*주세요|바꿔|진행|전환|시작|변경)(?:요)?$/.test(
      rest,
    )
  )
    return null;
  return match[1] === "일반개발" ? "general" : "federated";
}

/** A mention resumes a stopped federation only when its sentence asks to proceed. */
export function requestsFederation(text: string): boolean {
  if (requestedMode(text) === "general") return false;
  const mentions = text
    .trim()
    .split(/(?<=[.!?。！？])|[\r\n]+/u)
    .filter((sentence) => sentence.includes("연합개발"));
  return (
    mentions.length > 0 &&
    mentions.every(
      (sentence) =>
        // Stop commands exclude a mention; past descriptions and nouns can request a resume.
        !/[?？"'“”‘’`]|할까|할지|하면(?!서)|하려면|하지\s*(?:마|말)|(?:^|[\s,])마(?:요|세요|라)?(?=\s|[,.!。！？]|$)|말고|말아|않|아니(?!라)|금지|(?:중지|취소)\s*(?:해|하|시켜)|그만\s*(?:해|하|둬|두)|(?:^|\s)(?:중지|취소|그만)(?=\s*[.!。！？]?$)|멈춰|멈추|설명|비교|차이|뭐야|뭔가/.test(
          sentence,
        ),
    )
  );
}
