import { describe, expect, it } from "vitest";
import { nettoyerTexteRiche } from "../src/lib/texteRiche.js";

describe("texte riche des fiches", () => {
  it("garde la mise en forme simple, sans attribut", () => {
    expect(nettoyerTexteRiche('<b style="color:red">Le soir</b> après <i>22 h</i><br/><ul><li class="x">Paul</li></ul>')).toBe(
      "<b>Le soir</b> après <i>22 h</i><br><ul><li>Paul</li></ul>"
    );
  });

  it("retire tout ce qui s'exécute", () => {
    expect(nettoyerTexteRiche('<script>alert(1)</script>ok<img src=x onerror="alert(1)"><a href="javascript:x">lien</a>')).toBe("oklien");
    expect(nettoyerTexteRiche('<div onclick="x()">a</div>')).toBe("<div>a</div>");
    expect(nettoyerTexteRiche("<scr<script>ipt>alert(1)</script>")).not.toMatch(/<script/i);
  });

  it("vide → null", () => {
    expect(nettoyerTexteRiche("<div><br></div>&nbsp;")).toBeNull();
    expect(nettoyerTexteRiche(null)).toBeNull();
  });
});
