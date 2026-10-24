// A page passes through the filter and comes out checked: the logo's own gesture, used for every wait on the scan page.
// It shows no text of the resume and no verdicts (nothing here is known yet); it only says "work is moving". `tone` is the
// colour of the filter bars and the finishing tick.
export default function PassAnim({ tone = 'blue' }) {
  const fin = tone === 'green' ? 'text-green-600' : 'text-green-700'
  return (
    <div aria-hidden="true" data-testid="pass-anim" className="relative mb-2.5 h-[92px]">
      <div className="pt-sheet absolute left-[4%] top-2.5 grid h-[68px] w-[52px] content-start gap-[5px] rounded-md border-[1.5px] border-gray-300 bg-white px-[7px] py-[9px] [animation:pt-pass_3.4s_ease-in-out_infinite]">
        <i className="h-1 rounded-sm bg-gray-300" /><i className="h-1 w-[70%] rounded-sm bg-gray-300" /><i className="h-1 rounded-sm bg-gray-300" /><i className="h-1 w-1/2 rounded-sm bg-gray-300" />
      </div>
      <div className="absolute inset-y-1 left-[46%] flex w-11 justify-between"><s className="w-[9px] rounded-[5px] bg-blue-800" /><s className="w-[9px] rounded-[5px] bg-blue-800" /></div>
      <div className={`pt-fin absolute right-[5%] top-[22px] text-[30px] font-extrabold opacity-0 [animation:pt-fin_3.4s_ease-in-out_infinite] ${fin}`}>{'\u2713'}</div>
    </div>
  )
}
