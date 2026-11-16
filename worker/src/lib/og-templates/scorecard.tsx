import * as React from "react";
import { SOCIAL_PREVIEW_HEIGHT, SOCIAL_PREVIEW_WIDTH } from "@shared/lib/social-preview";
import { socialScorecardDate } from "@shared/lib/social-scorecard";
import type { SocialScorecardMetadata } from "@shared/types/social-scorecard";
import { PharosMark } from "./shared";

const INK = "#101e2b";
const PAPER = "#edf3f5";
const MUTED = "#a9bfcb";

function rows(value: string, size: number, width: number): string[] {
  const result: string[] = [];
  let row = "";
  let used = 0;
  for (const word of value.split(/\s+/)) {
    const wordWidth = [...word].reduce((sum, character) => sum + (/[MW@%]/.test(character) ? 0.92 : /[ilI.,]/.test(character) ? 0.31 : /[^\u0000-\u024f]/.test(character) ? 1 : 0.64), 0) * size;
    if (row && used + size * 0.3 + wordWidth > width) {
      result.push(row);
      row = "";
      used = 0;
    }
    if (wordWidth > width) {
      if (row) result.push(row);
      let part = "";
      for (const character of word) {
        if ((part.length + 1) * size > width) {
          result.push(part);
          part = "";
        }
        part += character;
      }
      row = part;
      used = part.length * size;
    } else {
      used += (row ? size * 0.3 : 0) + wordWidth;
      row = row ? `${row} ${word}` : word;
    }
  }
  if (row) result.push(row);
  return result;
}

export function Scorecard({ metadata }: { metadata: SocialScorecardMetadata }): React.ReactElement {
  const subject = metadata.subject;
  const overview = subject.kind === "overview";
  const method = metadata.publication.methodologyVersion;
  const calendarDate = new Date(metadata.asOfSec * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase();
  const heading = overview ? "Stablecoin safety" : subject.symbol;
  const name = overview ? "One accepted publication" : subject.name;
  let headingSize = overview ? 56 : 64;
  let nameSize = 30;
  let headingRows = rows(heading, headingSize, 576);
  let nameRows = rows(name, nameSize, 576);
  while (headingRows.length * headingSize * 1.05 + nameRows.length * nameSize * 1.05 + 8 > 180 && headingSize > 22) {
    headingSize -= 2;
    nameSize = Math.max(22, nameSize - 1);
    headingRows = rows(heading, headingSize, 576);
    nameRows = rows(name, nameSize, 576);
  }
  if (headingRows.length * headingSize * 1.05 + nameRows.length * nameSize * 1.05 + 8 > 180) throw new Error("Scorecard subject exceeds its readable text budget");
  return (
    <div style={{ width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT, position: "relative", display: "flex", background: INK, color: PAPER, fontFamily: "Geist Sans", lineHeight: 1.1 }}>
      <svg width="285" height="630" viewBox="0 0 285 630" style={{ position: "absolute", left: 0, top: 0 }}>
        <path d="M0 96L245 201V496L0 603Z" fill="#193349" />
        <path d="M0 183L225 279M0 242L225 338" fill="none" stroke="#4bc4de" strokeWidth="5" />
        <path d="M31 510L93 346H143L205 510Z" fill="none" stroke="#a9bfcb" strokeWidth="6" />
      </svg>
      <svg width="285" height="630" viewBox="0 0 285 630" style={{ position: "absolute", right: 0, top: 0 }}>
        <path d="M54 129H285V565H54Z" fill="#193349" />
        <path d="M54 129L197 129L285 217M197 129V217H285" fill="none" stroke="#4bc4de" strokeWidth="6" />
        <path d="M96 297H285M96 345H285M96 393H285" fill="none" stroke="#a9bfcb" strokeWidth="4" />
      </svg>
      <div style={{ position: "absolute", left: 312, top: 0, width: 576, height: 630, padding: "28px 0 22px", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, height: 44 }}>
          <PharosMark size={44} />
          <span style={{ fontSize: 27, fontWeight: 700 }}>PHAROS</span>
          <span style={{ marginLeft: "auto", fontSize: 20, color: MUTED }}>DATED SCORECARD</span>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 576 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", fontSize: headingSize, lineHeight: 1.05, fontWeight: 700 }}>{headingRows.map((row, index) => <span key={index}>{row}</span>)}</div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", fontSize: nameSize, lineHeight: 1.05, color: MUTED }}>{nameRows.map((row, index) => <span key={index}>{row}</span>)}</div>
          </div>
          {overview ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontSize: 108, lineHeight: 1, fontWeight: 700 }}>{subject.averageScore === null ? "N/A" : subject.averageScore.toFixed(1)}</div>
              <div style={{ fontSize: 25, color: MUTED }}>Mean rated score / 100</div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, width: 576 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 248 }}>
                <div style={{ fontSize: 124, lineHeight: 1, fontWeight: 700 }}>{subject.grade}</div>
                <div style={{ fontSize: 24, color: MUTED }}>Published grade</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9, width: 248 }}>
                <div style={{ fontSize: subject.score === null ? 42 : 76, lineHeight: 1, fontWeight: 700 }}>{subject.score === null ? "Not rated" : `${subject.score}`}</div>
                <div style={{ fontSize: 22, color: MUTED }}>{subject.score === null ? "No numeric score" : "Safety Score / 100"}</div>
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 576, padding: "10px 0", borderTop: "2px solid #4bc4de", borderBottom: "2px solid #4bc4de", fontSize: 27, fontWeight: 700 }}>{`${calendarDate} \u00b7 NOT LIVE`}</div>
          {overview && <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, fontSize: 24, color: MUTED }}><span>{`${subject.ratedCount} rated / ${subject.totalCount} total`}</span><span>{`${subject.notRatedCount} not rated / ${subject.unavailableCount} unavailable`}</span></div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, borderTop: "1px solid #344d5d", paddingTop: 12, fontSize: 20, color: MUTED }}>
          <span>{`Observed ${socialScorecardDate(metadata)}`}</span>
          <span>{`Methodology ${method.startsWith("v") ? method : `v${method}`} / Retained edition`}</span>
        </div>
      </div>
    </div>
  );
}
