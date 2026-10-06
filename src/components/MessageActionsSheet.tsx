import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import type { Message } from '@/src/config/types';
import { Icon, type IconName } from './Icon';
import { Pressable } from './Pressable';
import { QUICK_REACTIONS } from './EmojiRow';

export interface MessageAction {
  key: string;
  label: string;
  icon: IconName;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  message: Message | null;
  actions: MessageAction[];
  myReaction: string | null;
  onReact: (emoji: string) => void;
  onClose: () => void;
}

/** Long-press menu: a reaction strip above a vertical action list. */
export function MessageActionsSheet({
  message,
  actions,
  myReaction,
  onReact,
  onClose,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={Boolean(message)}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
        onPress={onClose}
      >
        <Pressable
          style={[styles.sheet, { backgroundColor: theme.colors.bgElevated, paddingBottom: insets.bottom + 16 }]}
          onPress={() => {}}
        >
          <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />

          {message && !message.deleted ? (
            <View style={[styles.reactions, { borderBottomColor: theme.colors.border }]}>
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => onReact(emoji)}
                  haptic
                  accessibilityLabel={`React ${emoji}`}
                  accessibilityState={{ selected: myReaction === emoji }}
                  style={[
                    styles.reactionButton,
                    myReaction === emoji
                      ? { backgroundColor: theme.colors.accentDim }
                      : null,
                  ]}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <ScrollView bounces={false}>
            {actions.map((action) => (
              <Pressable
                key={action.key}
                style={styles.action}
                onPress={() => {
                  action.onPress();
                  onClose();
                }}
              >
                <Icon
                  name={action.icon}
                  size={18}
                  color={action.destructive ? theme.colors.danger : theme.colors.textMuted}
                />
                <Text
                  style={[
                    styles.actionLabel,
                    { color: action.destructive ? theme.colors.danger : theme.colors.text },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    maxHeight: '72%',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  reactionButton: { padding: 7, borderRadius: 20 },
  reactionEmoji: { fontSize: 27 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 15,
    paddingHorizontal: 22,
  },
  actionLabel: { fontSize: 16 },
});
