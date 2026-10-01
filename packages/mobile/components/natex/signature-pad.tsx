import React from "react";
import { PanResponder, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Label, Small } from "./text";

/**
 * Signature capture for signature-policy merchants (§6 POD).
 *
 * Strokes are kept as point lists and exported as a self-contained SVG data
 * URL — no native canvas, no upload, so a signature taken in a basement is
 * complete evidence on the phone and travels in the outbox like any other
 * field. A stroke too short to be a mark (a tap, a brushed thumb) is not
 * counted; the server is told only about an actual signature.
 */

type Point = [number, number];

const HEIGHT = 200;
const MIN_POINTS = 12;

function pathOf(points: Point[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M${first![0].toFixed(1)} ${first![1].toFixed(1)}${rest
    .map(([x, y]) => ` L${x.toFixed(1)} ${y.toFixed(1)}`)
    .join("")}`;
}

export function signatureToDataUrl(strokes: Point[][], width: number): string {
  const paths = strokes
    .map(
      (s) =>
        `<path d="${pathOf(s)}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${HEIGHT}" viewBox="0 0 ${Math.round(width)} ${HEIGHT}">${paths}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function SignaturePad({
  onChange,
}: {
  /** Data URL once a real signature exists, null when cleared or too slight. */
  onChange: (dataUrl: string | null) => void;
}) {
  const colors = useColors();
  const [strokes, setStrokes] = React.useState<Point[][]>([]);
  const strokesRef = React.useRef<Point[][]>([]);
  const current = React.useRef<Point[] | null>(null);
  const width = React.useRef(320);
  const [, force] = React.useReducer((n: number) => n + 1, 0);

  const report = React.useCallback(
    (next: Point[][]) => {
      const total = next.reduce((n, s) => n + s.length, 0);
      onChange(total >= MIN_POINTS ? signatureToDataUrl(next, width.current) : null);
    },
    [onChange],
  );

  const point = (e: GestureResponderEvent): Point => [
    Math.max(0, Math.min(width.current, e.nativeEvent.locationX)),
    Math.max(0, Math.min(HEIGHT, e.nativeEvent.locationY)),
  ];

  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // The enclosing ScrollView must not steal a signature mid-stroke.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (e) => {
          current.current = [point(e)];
          force();
        },
        onPanResponderMove: (e) => {
          current.current?.push(point(e));
          force();
        },
        onPanResponderRelease: () => {
          const stroke = current.current;
          current.current = null;
          if (!stroke || stroke.length < 2) return force();
          const next = [...strokesRef.current, stroke];
          strokesRef.current = next;
          setStrokes(next);
          report(next);
        },
      }),
    [report],
  );

  const clear = () => {
    current.current = null;
    strokesRef.current = [];
    setStrokes([]);
    onChange(null);
  };

  const live = current.current;
  const hasInk = strokes.length > 0 || (live?.length ?? 0) > 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Label>Signature</Label>
        <Pressable
          onPress={clear}
          accessibilityRole="button"
          accessibilityLabel="Clear signature"
          style={styles.clear}
        >
          <Label color={colors.primary}>Clear</Label>
        </Pressable>
      </View>
      <View
        testID="signature-pad"
        onLayout={(e) => {
          width.current = e.nativeEvent.layout.width;
        }}
        style={[
          styles.pad,
          { borderColor: colors.border, backgroundColor: "#FFFFFF" },
          // react-native-web: stop the browser treating the stroke as a scroll.
          { touchAction: "none", userSelect: "none" } as object,
        ]}
        {...responder.panHandlers}
      >
        <Svg width="100%" height={HEIGHT} pointerEvents="none">
          {strokes.map((s, i) => (
            <Path
              key={i}
              d={pathOf(s)}
              stroke="#111111"
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {live ? (
            <Path
              d={pathOf(live)}
              stroke="#111111"
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </Svg>
        {!hasInk ? (
          <View style={styles.placeholder} pointerEvents="none">
            <Small color="#6B7280">Receiver signs here</Small>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.unit },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  clear: { minHeight: Space.minTouch, minWidth: Space.minTouch, justifyContent: "center", alignItems: "flex-end" },
  pad: { height: HEIGHT, borderWidth: 1, borderRadius: Space.radius, overflow: "hidden" },
  placeholder: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
