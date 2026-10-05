import { ReviewedBusinessCalendarSchema, type BusinessCalendarId, type ReviewedBusinessCalendar } from "../../types/business-calendars";

// Explicit tables only: no holiday-generation rules and no extrapolation past coverage.
const tables: ReviewedBusinessCalendar[] = [
  {
    id: "luxembourg-banking-target", timezone: "Europe/Luxembourg",
    coverage: { from: "2026-01-01", to: "2027-12-31" }, weekendDays: [0, 6],
    holidays: [
      "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-09", "2026-05-14", "2026-05-25", "2026-06-23", "2026-08-15", "2026-11-01", "2026-12-24", "2026-12-25", "2026-12-26",
      "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-01", "2027-05-06", "2027-05-09", "2027-05-17", "2027-06-23", "2027-08-15", "2027-11-01", "2027-12-24", "2027-12-25", "2027-12-26",
    ],
    sourceUrls: ["https://www.abbl.lu/professionals/public-and-bank-holidays/"], reviewedAt: "2026-10-05",
    notes: "Luxembourg statutory and bank holidays include all TARGET closures. Christmas Eve afternoon is conservatively excluded as a whole settlement day. Individual compensatory employee leave is not an additional jurisdiction-wide bank closure.",
  },
  {
    id: "brazil-b3-national", timezone: "America/Sao_Paulo",
    coverage: { from: "2026-01-01", to: "2026-12-31" }, weekendDays: [0, 6],
    holidays: ["2026-01-01", "2026-02-16", "2026-02-17", "2026-04-03", "2026-04-21", "2026-05-01", "2026-06-04", "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-24", "2026-12-25", "2026-12-31"],
    sourceUrls: ["https://www.b3.com.br/data/files/93/65/8E/25/9FE9B9109B5E99B9AC094EA8/CL%20003-2026-VNC%20ERRATA_CALENDARIO%20DE%20FERIADOS%20EM%202026%20E%20FUNCIONAMENTO%20DA%20B3%20EM%2018022026%20QUARTAFEIRA%20DE%20CINZAS_EN.pdf"], reviewedAt: "2026-10-05",
    notes: "B3 national banking/settlement calendar, including Carnival and Corpus Christi; Christmas Eve/New Year's Eve conservatively excluded for bank-delivered cash and centrally cleared settlement. November 15 is a Sunday national holiday. Ash Wednesday retains a settlement day; local Sao Paulo holidays are not B3 closures. No 2027 calendar has been reviewed.",
  },
  {
    id: "us-federal-reserve", timezone: "America/New_York",
    coverage: { from: "2026-01-01", to: "2027-12-31" }, weekendDays: [0, 6],
    holidays: [
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25",
    ],
    sourceUrls: ["https://www.federalreserve.gov/aboutthefed/k8.htm", "https://www.frbservices.org/about/holiday-schedules/"], reviewedAt: "2026-10-05",
    notes: "Federal Reserve Banks/financial services, not Board of Governors employee holidays: Saturday holidays do not close the preceding Friday, Sunday holidays close Monday. Individual bank/fund operating hours still require route-specific terms.",
  },
  {
    id: "frankfurt-banking-target", timezone: "Europe/Berlin",
    coverage: { from: "2026-01-01", to: "2026-12-31" }, weekendDays: [0, 6],
    holidays: ["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-25", "2026-06-04", "2026-10-03", "2026-12-24", "2026-12-25", "2026-12-26", "2026-12-31"],
    sourceUrls: ["https://www.bundesbank.de/resource/blob/764518/84d26dc9e3e0cc1e6e3042290df060ff/472B63F073F071307366337C94F8C870/feiertage-in-deutschland-1-data.pdf"], reviewedAt: "2026-10-05",
    notes: "Union of TARGET, Germany-wide, Hesse and Bundesbank non-business days. Midas' Frankfurt banks/clearing-system definition is not a Liechtenstein calendar; unidentified relevant commercial banks or clearing systems are still conditional gates. No 2027 calendar has been reviewed.",
  },
  {
    id: "hong-kong-banking", timezone: "Asia/Hong_Kong",
    coverage: { from: "2026-01-01", to: "2027-12-31" }, weekendDays: [0, 6],
    holidays: [
      "2026-01-01", "2026-02-17", "2026-02-18", "2026-02-19", "2026-04-03", "2026-04-04", "2026-04-06", "2026-04-07", "2026-05-01", "2026-05-25", "2026-06-19", "2026-07-01", "2026-09-26", "2026-10-01", "2026-10-19", "2026-12-25", "2026-12-26",
      "2027-01-01", "2027-02-06", "2027-02-08", "2027-02-09", "2027-03-26", "2027-03-27", "2027-03-29", "2027-04-05", "2027-05-01", "2027-05-13", "2027-06-09", "2027-07-01", "2027-09-16", "2027-10-01", "2027-10-08", "2027-12-25", "2027-12-27",
    ],
    sourceUrls: ["https://www.gov.hk/en/about/abouthk/holiday/2026.htm", "https://www.gov.hk/en/about/abouthk/holiday/2027.htm"], reviewedAt: "2026-10-05",
    notes: "Gazetted Hong Kong general holidays with Saturday conservatively excluded for banking. FinChain explicitly specifies Hong Kong daily processing and 08:00 cutoff; no Singapore/Cayman calendar is inferred from underlying fund domicile.",
  },
];
export const REVIEWED_BUSINESS_CALENDARS: Readonly<Record<BusinessCalendarId, ReviewedBusinessCalendar>> = Object.fromEntries(
  tables.map((table) => [table.id, ReviewedBusinessCalendarSchema.parse(table)]),
) as Record<BusinessCalendarId, ReviewedBusinessCalendar>;
