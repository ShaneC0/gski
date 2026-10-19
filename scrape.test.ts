import assert from "node:assert/strict";
import { requirements } from "./scrape.ts";

assert.deepEqual(requirements("Tenant must earn 3x the monthly rent", 1500), { incomeMin: 54000, income: "3x rent", credit: null });
assert.deepEqual(requirements("income of 40 times the rent, credit score of 650+", 1500), { incomeMin: 60000, income: "40x rent", credit: 650 });
assert.deepEqual(requirements("Minimum household income $55,000 per year", 1400), { incomeMin: 55000, income: "stated minimum", credit: null });
assert.equal(requirements("Rent is $1,500 per month", 1500).incomeMin, null);
assert.equal(requirements("Credit check required", 1500).income, "income/credit check, no number given");
assert.equal(requirements("Nice 1BR with parking", 1500).income, null);
assert.deepEqual(requirements("Security Deposit: FICO Score 630+ 1.5x the Rent", 1500), { incomeMin: null, income: null, credit: 630 });
assert.equal(requirements("Must make 2.5x the rent after taxes", 1100).incomeMin, 33000);
console.log("ok");
