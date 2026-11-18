// England and Wales bank holidays for the modeled London vault release:
// https://www.gov.uk/bank-holidays
const londonBanking = {
  timezone: "Europe/London",
  coverage: { from: "2026-10-01", to: "2027-12-31" },
  weekendDays: [0, 6],
  holidays: [
    "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
    "2027-08-30", "2027-12-27", "2027-12-28",
  ],
};

// LBMA value dates allow the conservative clear-business-day convention
// in both London and New York: https://www.lbma.org.uk/prices-and-data/value-dates
const lbmaUsdSettlement = {
  ...londonBanking,
  holidays: [...londonBanking.holidays,
    "2026-10-12", "2026-11-11", "2026-11-26",
    "2027-01-18", "2027-02-15", "2027-06-18", "2027-07-05", "2027-09-06",
    "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31",
  ],
};

export const PHYSICAL_SETTLEMENT_CALENDARS = {
  "london-banking": londonBanking,
  "lbma-usd-settlement": lbmaUsdSettlement,
};
