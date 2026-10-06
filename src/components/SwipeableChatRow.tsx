import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Icon, type IconName } from './Icon';

/**
 * Chat-list swipe actions.
 *
 * Swipe right pins/unpins, swipe left archives — the same directions WhatsApp
 * uses, so the muscle memory transfers. The action panel is revealed *behind*
 * the row rather than sliding in beside it, which is what makes the row feel
 * like it is being pulled off a stack instead of animating on a canvas.
 *
 * Distinct from `SwipeableRow`, which is swipe-to-reply on a message bubble:
 * that one snaps back always and never commits on release.
 */

/**
 * Panel icon and label colour. The panel background is `action.color` — a
 * saturated accent or slate supplied by the caller — so white is the correct
 * pairing in both themes and is not a theme token by omission.
 */
const ON_PANEL = '#FFFFFF';

/** Drag distance at which the action commits on release. */
const TRIGGER = 76;
/** Hard stop, so a fast flick cannot drag the row off screen. */
const MAX_DRAG = 128;

export interface SwipeAction {
  icon: IconName;
  label: string;
  /** Panel background. Pin uses the accent, archive a neutral slate. */
  color: string;
  onTrigger: () => void;
}

interface Props {
  children: React.ReactNode;
  /** Revealed by a left-to-right drag. */
  right?: SwipeAction;
  /** Revealed by a right-to-left drag. */
  left?: SwipeAction;
  enabled?: boolean;
}

export function SwipeableChatRow({ children, right, left, enabled = true }: Props) {
  const theme = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  // Which side crossed the trigger, not merely *that* one did. Recomputing the
  // side from the release position lets a drag that arms right, then swings back
  // across zero, commit the left action — the opposite of what the user last saw.
  const armedSide = useRef<'left' | 'right' | null>(null);
  // Which panel is currently showing. Kept in a ref (not state) so the gesture
  // does not re-render the row on every frame of the drag.
  const activeSide = useRef<'left' | 'right' | null>(null);

  const settle = useCallback(
    (commit: SwipeAction | null) => {
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        speed: 18,
        bounciness: 0,
      }).start(() => {
        activeSide.current = null;
      });
      // Fire after the spring starts, not after it finishes: waiting makes the
      // list reorder a beat behind the finger and reads as lag.
      commit?.onTrigger();
    },
    [translateX]
  );

  useEffect(() => {
    // Committing pins or archives, which reorders or removes this row from the
    // list — so the row is very often unmounted while the settle spring is still
    // running. Stop it, or the spring keeps driving a detached node and its
    // completion callback fires afterwards.
    return () => translateX.stopAnimation();
  }, [translateX]);

  // Pin and archive live behind a pan gesture, which does not exist for anyone
  // driving the app with VoiceOver, TalkBack, or a switch device. Exposing them
  // as accessibility actions is the only way those users can reach them at all:
  // AT surfaces them in the actions rotor / local context menu on the row.
  // Note the deps: callers pass inline action objects, so memoising on the
  // object identities would never hit. The callbacks themselves are stable
  // (useCallback upstream); the labels are what the memo actually reads.
  const rightLabel = right?.label;
  const rightTrigger = right?.onTrigger;
  const leftLabel = left?.label;
  const leftTrigger = left?.onTrigger;

  const a11yActions = useMemo(() => {
    const actions: { name: string; label: string }[] = [];
    if (rightLabel) actions.push({ name: 'swipeRight', label: rightLabel });
    if (leftLabel) actions.push({ name: 'swipeLeft', label: leftLabel });
    return actions;
  }, [rightLabel, leftLabel]);

  const onA11yAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      const trigger =
        event.nativeEvent.actionName === 'swipeRight' ? rightTrigger : leftTrigger;
      // No spring to settle — the row never moved — so trigger directly.
      trigger?.();
    },
    [rightTrigger, leftTrigger]
  );

  const pan = Gesture.Pan()
    .enabled(enabled && Boolean(right || left))
    // Horizontal intent only — a near-vertical drag must stay with the FlatList.
    .activeOffsetX([-16, 16])
    .failOffsetY([-14, 14])
    .onUpdate((event) => {
      const dx = event.translationX;
      const side = dx > 0 ? 'right' : 'left';
      const action = side === 'right' ? right : left;

      if (!action) {
        translateX.setValue(0);
        return;
      }

      activeSide.current = side;

      // Rubber-band past the trigger point so the row feels tethered.
      const magnitude = Math.abs(dx);
      const eased =
        magnitude > TRIGGER ? TRIGGER + (magnitude - TRIGGER) * 0.3 : magnitude;
      const clamped = Math.min(eased, MAX_DRAG);

      translateX.setValue(side === 'right' ? clamped : -clamped);

      // One tick when crossing the threshold, so the commit point is felt
      // rather than guessed. Re-arming on a *different* side re-ticks, because
      // that is a new commit the user needs to feel.
      if (magnitude >= TRIGGER) {
        if (armedSide.current !== side) {
          armedSide.current = side;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      } else {
        armedSide.current = null;
      }
    })
    .onEnd(() => {
      // Commit the side that armed, so the action that fires is the panel that
      // was open when the finger let go.
      const side = armedSide.current;
      const action = side === 'right' ? right : side === 'left' ? left : undefined;
      armedSide.current = null;
      settle(action ?? null);
    })
    .runOnJS(true);

  // Both panels are mounted and each is clipped to its own half of the row, so
  // the correct one is already in place the instant the drag begins.
  const renderPanel = (action: SwipeAction | undefined, side: 'left' | 'right') => {
    if (!action) return null;
    return (
      <View
        style={[
          styles.panel,
          side === 'right' ? styles.panelRight : styles.panelLeft,
          { backgroundColor: action.color },
        ]}
        pointerEvents="none"
        // The panel only ever restates the action already announced via
        // `accessibilityActions` on the wrapper, so leaving it in the tree would
        // just read the same label twice.
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View style={styles.panelInner}>
          <Icon name={action.icon} size={22} color={ON_PANEL} />
          <Text style={styles.panelLabel} numberOfLines={1}>
            {action.label}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.wrapper, { backgroundColor: theme.colors.bg }]}>
      {renderPanel(right, 'right')}
      {renderPanel(left, 'left')}

      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            { backgroundColor: theme.colors.bg },
            { transform: [{ translateX }] },
          ]}
        >
          {/* The wrapper View above is not an accessible element, so actions
              declared on it never reach AT. They ride on the row itself instead,
              which already owns the label they act on. */}
          {React.isValidElement<{ swipeActions?: unknown; onSwipeAction?: unknown }>(children)
            ? React.cloneElement(children, {
                swipeActions: a11yActions,
                onSwipeAction: onA11yAction,
              })
            : children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { overflow: 'hidden' },
  // Clipped to the drag distance, not half the row: a 50% wash reads as a
  // selection state rather than a revealed action.
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: MAX_DRAG,
    justifyContent: 'center',
  },
  panelRight: { left: 0, alignItems: 'flex-start', paddingLeft: 24 },
  panelLeft: { right: 0, alignItems: 'flex-end', paddingRight: 24 },
  panelInner: { alignItems: 'center', gap: 4 },
  panelLabel: { color: ON_PANEL, fontSize: 12, fontWeight: '600' },
});
