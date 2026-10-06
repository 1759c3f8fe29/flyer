import React, { useRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/src/theme/ThemeProvider';
import { Icon } from './Icon';
import { Pressable } from './Pressable';

interface Props {
  value: string;
  onChangeText: (value: string) => void;
  onClose: () => void;
  placeholder?: string;
  /**
   * Opt-in: popping the keyboard uninvited traps the user in it, so only the
   * screen that just revealed this field asks for focus.
   */
  autoFocus?: boolean;
}

/**
 * Inline search field. The trailing button clears the term while there is one to
 * clear and dismisses search once the field is empty, so a single thumb position
 * covers both intents.
 */
export function SearchBar({ value, onChangeText, onClose, placeholder = 'Search', autoFocus = false }: Props) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);

  const hasText = value.length > 0;

  return (
    // bgElevated matches the header behind this pill, so the field needs its
    // own fill and hairline to read as a field at all.
    <View style={[styles.pill, { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border }]}>
      <Icon name="search" size={20} color={theme.colors.textMuted} style={styles.leading} />

      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        style={[styles.input, { color: theme.colors.text }]}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel={placeholder}
      />

      <Pressable
        onPress={() => {
          if (hasText) {
            onChangeText('');
            inputRef.current?.focus();
          } else {
            onClose();
          }
        }}
        round={44}
        accessibilityLabel={hasText ? 'Clear search' : 'Close search'}
      >
        <Icon name="close" size={16} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 12,
    paddingRight: 2,
    minHeight: 44,
  },
  leading: { marginRight: 8 },
  input: { flex: 1, fontSize: 16, paddingVertical: 10 },
});
