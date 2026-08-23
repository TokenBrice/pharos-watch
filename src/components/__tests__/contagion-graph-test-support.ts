export function installSvgCoordinateShim(): void {
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value() {
      const point = {
        x: 0,
        y: 0,
        matrixTransform() {
          return { x: point.x, y: point.y };
        },
      };
      return point;
    },
  });

  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value() {
      return {
        inverse() {
          return null;
        },
      };
    },
  });
}
