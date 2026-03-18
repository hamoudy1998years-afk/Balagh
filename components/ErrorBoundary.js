import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/theme';

export default class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    __DEV__ && console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>
            The app ran into an unexpected error.{'\n'}Tap below to try again.
          </Text>
          {__DEV__ && this.state.error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorDetail} numberOfLines={4}>
                {this.state.error.toString()}
              </Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => this.setState({ hasError: false, error: null })}
            activeOpacity={0.8}
          >
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0f1e',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emoji: {
    fontSize: 56,
    marginBottom: 4,
  },
  title: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 8,
  },
  errorBox: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    width: '100%',
    marginBottom: 4,
  },
  errorDetail: {
    color: '#f87171',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  retryBtn: {
    backgroundColor: COLORS.gold,
    borderRadius: 12,
    paddingHorizontal: 40,
    paddingVertical: 14,
    marginTop: 8,
  },
  retryBtnText: {
    color: '#0a0f1e',
    fontSize: 16,
    fontWeight: '700',
  },
});
