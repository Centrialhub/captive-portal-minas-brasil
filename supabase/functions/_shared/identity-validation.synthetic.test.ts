import { describe, expect, it } from "vitest";
import { isValidCPF, isValidBrazilianPhone, isPlaceholderPhone, normalizeBrazilianPhone, normalizeCPF, VALID_BR_DDD } from "./identity.ts";
import { formatCPF, formatPhoneBR, Validators } from "../../../src/lib/portal-utils.ts";

describe("shared identity validation regression", () => {
  it("uses the same functions in the frontend", () => {
    expect(Validators.cpf).toBe(isValidCPF);
    expect(Validators.phone).toBe(isValidBrazilianPhone);
  });
  it.each(["00000000000", "11111111111", "12345678900", "52998224724", "529982247250", "abc52998224725", "+52998224725", "٥٢٩٩٨٢٢٤٧٢٥"])("rejects invalid or malformed CPF %s without changing identity", value => {
    expect(isValidCPF(value)).toBe(false);
    expect(isValidCPF(formatCPF(value))).toBe(false);
  });
  it.each(["52998224725", "529.982.247-25", " 529.982.247-25 ", "12345678909", "01234567890"])("accepts checksum-valid CPF %s without claiming registration", value => expect(isValidCPF(value)).toBe(true));
  it("matches an independent calculation for one million deterministic candidates", () => {
    let mismatches=0;
    for(let base=100000000;base<100010000;base++) for(let suffix=0;suffix<100;suffix++) {
      const value=String(base)+String(suffix).padStart(2,"0");
      const first=[...value.slice(0,9)].reduce((a,n,i)=>a+Number(n)*(10-i),0)*10%11%10;
      const second=[...value.slice(0,10)].reduce((a,n,i)=>a+Number(n)*(11-i),0)*10%11%10;
      const expected=first===Number(value[9])&&second===Number(value[10]);
      if(isValidCPF(value)!==expected)mismatches++;
    }
    expect(mismatches).toBe(0);
  });
  it("preserves mobile, landline and +55 identities across every valid DDD", () => {
    for(const ddd of VALID_BR_DDD) for(const subscriber of ["987654321","23456789","34567890","45678901","56789012"]){
      const expected=String(ddd)+subscriber;
      for(const value of [expected,"55"+expected,`+55 (${ddd}) ${subscriber}`,`(${ddd}) ${subscriber}`]){
        expect(isValidBrazilianPhone(value),value).toBe(true);
        expect(normalizeBrazilianPhone(value),value).toBe(expected);
        expect(normalizeBrazilianPhone(formatPhoneBR(value)),value).toBe(expected);
      }
    }
  });
  it.each(["+91 98765-4321", "+55 91999-9999", "(55) 98765-432100", "abc38987654321", "38987654321x7", "++5538987654321", "20987654321", "38876543210", null, 38987654321])("rejects malformed phone %s", value=>expect(isValidBrazilianPhone(value)).toBe(false));
  it("rejects uniform subscriber placeholders across every DDD and formatting",()=>{
    for(const ddd of VALID_BR_DDD) for(let digit=0;digit<=9;digit++) for(const subscriber of [String(digit).repeat(8),"9"+String(digit).repeat(8)]) {
      for(const value of [String(ddd)+subscriber,`+55 (${ddd}) ${subscriber}`,`(${ddd}) ${subscriber}`]){
        expect(isPlaceholderPhone(value),value).toBe(true);
        expect(isValidBrazilianPhone(value),value).toBe(false);
      }
    }
    expect(isPlaceholderPhone("38987654321")).toBe(false);
    expect(normalizeCPF("abc52998224725")).toBe("");
  });
  it("rejects the requested 912345678 subscriber across all DDDs and formats",()=>{
    for(const ddd of VALID_BR_DDD) for(const value of [`${ddd}912345678`,`(${ddd}) 91234-5678`,`+55 (${ddd}) 91234-5678`,`55${ddd}912345678`]) {
      expect(isPlaceholderPhone(value),value).toBe(true);
      expect(isValidBrazilianPhone(value),value).toBe(false);
    }
  });
  it.each(["38999999998","38900000001","3833333334","3832222222","+55 (55) 99999-9998","38912345679","38912345677"])("preserves non-placeholder phone %s",value=>expect(isValidBrazilianPhone(value)).toBe(true));
});
