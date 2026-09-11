import type { IndependentAssuranceProduct } from "@shared/lib/independent-assurance";
import type { CompilerProfile } from "./shared";

export const COMPILER_PROFILES: Partial<Record<IndependentAssuranceProduct, CompilerProfile>> = {};

import { PROFILE as AUDD } from "./audd"; COMPILER_PROFILES.AUDD = AUDD;
import { PROFILE as AUDM } from "./audm"; COMPILER_PROFILES.AUDM = AUDM;
import { PROFILE as AUSD } from "./ausd"; COMPILER_PROFILES.AUSD = AUSD;
import { PROFILE as AUDX } from "./audx"; COMPILER_PROFILES.AUDX = AUDX;
import { PROFILE as BRLA } from "./brla"; COMPILER_PROFILES.BRLA = BRLA;
import { PROFILE as BRLV } from "./brlv"; COMPILER_PROFILES.BRLV = BRLV;
import { PROFILE as CADD } from "./cadd"; COMPILER_PROFILES.CADD = CADD;
import { PROFILE as EUROP } from "./europ"; COMPILER_PROFILES.EUROP = EUROP;
import { PROFILE as FDUSD } from "./fdusd"; COMPILER_PROFILES.FDUSD = FDUSD;
import { PROFILE as FIDD } from "./fidd"; COMPILER_PROFILES.FIDD = FIDD;
import { PROFILE as GUSD } from "./gusd"; COMPILER_PROFILES.GUSD = GUSD;
import { PROFILE as PYUSD } from "./pyusd"; COMPILER_PROFILES.PYUSD = PYUSD;
import { PROFILE as SBC } from "./sbc"; COMPILER_PROFILES.SBC = SBC;
import { PROFILE as USDG } from "./usdg"; COMPILER_PROFILES.USDG = USDG;
import { PROFILE as USDGO } from "./usdgo"; COMPILER_PROFILES.USDGO = USDGO;
import { PROFILE as USAT } from "./usat"; COMPILER_PROFILES.USAT = USAT;
import { PROFILE as USDPT } from "./usdpt"; COMPILER_PROFILES.USDPT = USDPT;
import { PROFILE as USDP } from "./usdp"; COMPILER_PROFILES.USDP = USDP;
import { PROFILE as XSGD } from "./xsgd"; COMPILER_PROFILES.XSGD = XSGD;
import { PROFILE as XUSD } from "./xusd"; COMPILER_PROFILES.XUSD = XUSD;
import { PROFILE as PAXG } from "./paxg"; COMPILER_PROFILES.PAXG = PAXG;
