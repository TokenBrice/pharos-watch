import type { IndependentAssuranceProduct } from "@shared/lib/independent-assurance";

export const MANIFEST_SOURCES: Partial<Record<IndependentAssuranceProduct, unknown>> = {};

import AUDD from "./audd.json"; MANIFEST_SOURCES.AUDD = AUDD;
import AUDM from "./audm.json"; MANIFEST_SOURCES.AUDM = AUDM;
import AUSD from "./ausd.json"; MANIFEST_SOURCES.AUSD = AUSD;
import AUDX from "./audx.json"; MANIFEST_SOURCES.AUDX = AUDX;
import BRLA from "./brla.json"; MANIFEST_SOURCES.BRLA = BRLA;
import BRLV from "./brlv.json"; MANIFEST_SOURCES.BRLV = BRLV;
import CADD from "./cadd.json"; MANIFEST_SOURCES.CADD = CADD;
import EUROP from "./europ.json"; MANIFEST_SOURCES.EUROP = EUROP;
import FDUSD from "./fdusd.json"; MANIFEST_SOURCES.FDUSD = FDUSD;
import FIDD from "./fidd.json"; MANIFEST_SOURCES.FIDD = FIDD;
import GUSD from "./gusd.json"; MANIFEST_SOURCES.GUSD = GUSD;
import PYUSD from "./pyusd.json"; MANIFEST_SOURCES.PYUSD = PYUSD;
import SBC from "./sbc.json"; MANIFEST_SOURCES.SBC = SBC;
import USDG from "./usdg.json"; MANIFEST_SOURCES.USDG = USDG;
import USDGO from "./usdgo.json"; MANIFEST_SOURCES.USDGO = USDGO;
import USDPT from "./usdpt.json"; MANIFEST_SOURCES.USDPT = USDPT;
import USDP from "./usdp.json"; MANIFEST_SOURCES.USDP = USDP;
import USAT from "./usat.json"; MANIFEST_SOURCES.USAT = USAT;
import XSGD from "./xsgd.json"; MANIFEST_SOURCES.XSGD = XSGD;
import XUSD from "./xusd.json"; MANIFEST_SOURCES.XUSD = XUSD;
import PAXG from "./paxg.json"; MANIFEST_SOURCES.PAXG = PAXG;
