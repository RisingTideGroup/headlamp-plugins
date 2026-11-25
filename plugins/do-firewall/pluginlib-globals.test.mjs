import { describe, expect, it } from "vitest";
import { globalFor } from "./pluginlib-globals.mjs";

describe("pluginLib globals (the @kinvolk/headlamp-plugin CLI's mapping)", () => {
  it("maps each import this plugin uses", () => {
    expect(globalFor("react")).toBe("pluginLib.React");
    expect(globalFor("react/jsx-runtime")).toBe("pluginLib.ReactJSX");
    expect(globalFor("@mui/material")).toBe("pluginLib.MuiMaterial");
    expect(globalFor("@mui/material/Button")).toBe("pluginLib.MuiMaterial.Button");
    expect(globalFor("@kinvolk/headlamp-plugin/lib")).toBe("pluginLib");
    expect(globalFor("@kinvolk/headlamp-plugin/lib/CommonComponents")).toBe("pluginLib.CommonComponents");
  });

  it("refuses anything it cannot map to a plain property", () => {
    expect(globalFor("react-dom")).toBeNull();
    expect(globalFor("@mui/material/x-y")).toBeNull();
    expect(globalFor("lodash")).toBeNull();
  });
});
