import React from "react";
import { Animated, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "../../hooks/useTheme";

// Breathing placeholder shown while data is loading. Replaces blank "$0.00"
// and empty lists on first open so the UI clearly reads as "fetching", not
// "broken".
export function Skeleton({
  width,
  height,
  radius = 8,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: ViewStyle;
}) {
  const { theme } = useTheme();
  const opacity = React.useRef(new Animated.Value(0.45)).current;

  React.useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.base,
        { width, height, borderRadius: radius, backgroundColor: theme.surface, opacity },
        style,
      ] as unknown as ViewStyle}
    />
  );
}

const styles = StyleSheet.create({
  base: { overflow: "hidden" },
});
