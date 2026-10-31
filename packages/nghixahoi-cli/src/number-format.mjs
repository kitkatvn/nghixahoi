// How Kit=Code writes a number a person reads, in the CLI's text, the prompt hook's context, the setup prompts and the Mini: one
// formatter, so that every surface writes a count the same way. Since 2026-10-30 (web/13-number-format; the operator: "add thousand
// seperater , to numbers: 2000000 -> 2,000,000. and what if the numbers are too long? in the minibar and the dashboard"). The
// dashboard's own copy is apps/web/src/lib/number-format.ts, which apps/web/test/number-format.test.ts holds to this one.
//
// - groupedNumber: a whole number with a comma between each three digits, "2,000,000"; under 1,000 as it was, "999". Every place has
//   room for it but the Mini's and the dashboard's counters.
// - shortNumber: a counter's value. Up to 999,999 the grouped number. From 1,000,000 one decimal and "M", the decimal a point, never a
//   comma: "1.2M", "12.5M". Rounded to the nearest tenth of a million, a half up, so 12,449,999 is "12.4M", 12,450,000 and 12,499,999
//   "12.5M", and 999,999 never reaches it; an exact million has no decimal, "1M", "2M", while anything else keeps it, so 1,000,001 is
//   "1.0M", as it is not 1M. From 1,000,000,000 (or a value that rounds to 1,000.0M) the same in billions, "B".
// - focusTime: focus time in hours and minutes, "11h 48m", "45m", "30s", as it was; from 1,000 hours whole hours with commas, "1,234h",
//   since "1.2Kh" reads badly. focusTimeFull keeps the minutes past 1,000 hours, "1,234h 5m", for a tooltip.
//
// The Mini's page carries these same functions, written into its script by their source (MINI_NUMBER_SCRIPT), so the page and the CLI
// cannot write a number differently. Each therefore uses nothing outside itself but the others here, by name.

export function groupedNumber(value) {
  const whole = Math.trunc(Number(value) || 0);
  return (whole < 0 ? '-' : '') + String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function shortNumber(value) {
  const whole = Math.max(0, Math.trunc(Number(value) || 0));
  if (whole < 1000000) return groupedNumber(whole);
  const tenthsOfMillions = Math.floor((whole + 50000) / 100000);
  if (tenthsOfMillions < 10000) {
    return whole % 1000000 === 0 ? (whole / 1000000) + 'M' : Math.floor(tenthsOfMillions / 10) + '.' + (tenthsOfMillions % 10) + 'M';
  }
  const tenthsOfBillions = Math.floor((whole + 50000000) / 100000000);
  return whole % 1000000000 === 0 ? groupedNumber(whole / 1000000000) + 'B' : groupedNumber(Math.floor(tenthsOfBillions / 10)) + '.' + (tenthsOfBillions % 10) + 'B';
}

export function focusTimeFull(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  if (totalSeconds < 60) return totalSeconds + 's';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? groupedNumber(hours) + 'h ' + minutes + 'm' : groupedNumber(hours) + 'h';
  return minutes + 'm';
}

export function focusTime(seconds) {
  const hours = Math.floor(Math.max(0, Math.floor(Number(seconds) || 0)) / 3600);
  return hours >= 1000 ? groupedNumber(hours) + 'h' : focusTimeFull(seconds);
}

// The functions above as the Mini's script declares them.
export const MINI_NUMBER_SCRIPT = [groupedNumber, shortNumber, focusTimeFull, focusTime].map((fn) => fn.toString()).join('\n');
