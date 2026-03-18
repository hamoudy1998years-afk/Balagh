import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Switch, Animated, StatusBar, Alert, Image, Modal,
  TextInput, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform, BackHandler,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { userCache } from '../utils/userCache';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../constants/theme';
import { clearFeedCache } from './HomeScreen';

const ACCENT     = COLORS.gold;
const ACCENT_DIM = `${COLORS.gold}18`;
const BG         = '#ffffff';
const CARD       = '#f5f5f5';
const BORDER     = '#e5e5e5';
const TEXT       = '#111111';
const SUBTEXT    = '#888888';
const MUTED      = '#dddddd';
const DANGER     = COLORS.live;

function Row({ icon, label, sublabel, onPress, right, danger, last }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pi = () => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, tension: 300, friction: 10 }).start();
  const po = () => Animated.spring(scale, { toValue: 1,    useNativeDriver: true, tension: 300, friction: 10 }).start();
  return (
    <>
      <Animated.View style={{ transform: [{ scale }] }}>
        <TouchableOpacity onPress={onPress} onPressIn={pi} onPressOut={po} activeOpacity={1} style={styles.row}>
          <View style={[styles.rowIcon, { backgroundColor: danger ? '#FF456018' : ACCENT_DIM }]}>
            <Text style={{ fontSize: 17 }}>{icon}</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.rowLabel, danger && { color: DANGER }]}>{label}</Text>
            {sublabel ? <Text style={styles.rowSub}>{sublabel}</Text> : null}
          </View>
          <View style={styles.rowEnd}>{right ?? <Text style={styles.chevron}>›</Text>}</View>
        </TouchableOpacity>
      </Animated.View>
      {!last && <View style={styles.rowDivider} />}
    </>
  );
}

function CategoryButton({ icon, label, sublabel, onPress, last }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pi = () => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, tension: 300, friction: 10 }).start();
  const po = () => Animated.spring(scale, { toValue: 1,    useNativeDriver: true, tension: 300, friction: 10 }).start();
  return (
    <>
      <Animated.View style={{ transform: [{ scale }] }}>
        <TouchableOpacity onPress={onPress} onPressIn={pi} onPressOut={po} activeOpacity={1} style={styles.catRow}>
          <View style={[styles.catIcon, { backgroundColor: ACCENT_DIM }]}>
            <Text style={{ fontSize: 20 }}>{icon}</Text>
          </View>
          <View style={styles.catBody}>
            <Text style={styles.catLabel}>{label}</Text>
            {sublabel ? <Text style={styles.catSub}>{sublabel}</Text> : null}
          </View>
          <Text style={styles.catChevron}>›</Text>
        </TouchableOpacity>
      </Animated.View>
      {!last && <View style={styles.catDivider} />}
    </>
  );
}

function ASwitch({ value, onValueChange }) {
  return (
    <Switch
      value={value} onValueChange={onValueChange}
      trackColor={{ false: MUTED, true: ACCENT + '50' }}
      thumbColor={value ? ACCENT : '#aaaaaa'}
      ios_backgroundColor={MUTED}
    />
  );
}

function ThemeToggle({ isDark, onToggle }) {
  const anim = useRef(new Animated.Value(isDark ? 1 : 0)).current;
  const toggle = () => {
    Animated.spring(anim, { toValue: isDark ? 0 : 1, useNativeDriver: false, tension: 80, friction: 8 }).start();
    onToggle();
  };
  const knobX   = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 26] });
  const trackBg = anim.interpolate({ inputRange: [0, 1], outputRange: [MUTED, `${COLORS.gold}30`] });
  return (
    <TouchableOpacity onPress={toggle} activeOpacity={0.8}>
      <Animated.View style={[styles.toggleTrack, { backgroundColor: trackBg }]}>
        <Animated.View style={[styles.toggleKnob, { left: knobX }]}>
          <Text style={{ fontSize: 11 }}>{isDark ? '🌙' : '☀️'}</Text>
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
}

function Card({ children }) {
  return <View style={styles.card}>{children}</View>;
}

function AnimatedButton({ label, onPress, danger, outline }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pi = () => Animated.spring(scale, { toValue: 0.94, useNativeDriver: true, tension: 300, friction: 10 }).start();
  const po = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 300, friction: 10 }).start();
  return (
    <Animated.View style={{ transform: [{ scale }], flex: 1 }}>
      <TouchableOpacity
        onPressIn={pi} onPressOut={po} onPress={onPress} activeOpacity={1}
        style={[styles.modalBtn, danger && styles.modalBtnDanger, outline && styles.modalBtnOutline]}
      >
        <Text style={[styles.modalBtnText, danger && styles.modalBtnTextDanger, outline && styles.modalBtnTextOutline]}>
          {label}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function SubScreen({ title, onBack, insets, children }) {
  return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={onBack} style={styles.subBack}>
          <Text style={styles.subBackIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.subTitle}>{title}</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.subScroll, { paddingBottom: insets.bottom + 40 }]}>
        {children}
      </ScrollView>
    </View>
  );
}

function GroupLabel({ text }) {
  return <Text style={styles.groupLabel}>{text}</Text>;
}

function SavingBanner({ visible }) {
  if (!visible) return null;
  return (
    <View style={styles.savingBanner}>
      <ActivityIndicator color={ACCENT} size="small" />
      <Text style={styles.savingText}>Saving...</Text>
    </View>
  );
}

export default function SettingsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [screen, setScreen] = useState(null);

  const [profile,     setProfile]     = useState(null);
  const [currentUser, setCurrentUser] = useState(null);

  const [notifAll,       setNotifAll]       = useState(true);
  const [notifComments,  setNotifComments]  = useState(true);
  const [notifLikes,     setNotifLikes]     = useState(true);
  const [notifFollowers, setNotifFollowers] = useState(true);
  const [notifMessages,  setNotifMessages]  = useState(true);
  const [savingNotif,    setSavingNotif]    = useState(false);

  const [commentPerm,   setCommentPerm]   = useState('everyone');
  const [showLikes,     setShowLikes]     = useState(true);
  const [savingPrivacy, setSavingPrivacy] = useState(false);

  const [phone,        setPhone]        = useState('');
  const [phoneInput,   setPhoneInput]   = useState('');
  const [editingPhone, setEditingPhone] = useState(false);
  const [savingPhone,  setSavingPhone]  = useState(false);

  const [blockedUsers,   setBlockedUsers]   = useState([]);
  const [blockedLoading, setBlockedLoading] = useState(false);

  const [isDark, setIsDark] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  useEffect(() => { init(); }, []);

  useEffect(() => {
    const backAction = () => {
      if (screen === 'blocked') { setScreen('privacy'); return true; }
      if (screen === 'faq' || screen === 'contact' || screen === 'terms' || screen === 'privacypolicy') { setScreen('help'); return true; }
      if (screen !== null) { setScreen(null); return true; }
      return false;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [screen]);

  async function init() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setCurrentUser(user);
    const { data } = await supabase
      .from('profiles')
      .select('username, full_name, avatar_url, phone, notif_all, notif_comments, notif_likes, notif_followers, notif_messages, comment_permission, show_likes')
      .eq('id', user.id)
      .single();
    if (data) {
      setProfile(data);
      setPhone(data.phone ?? '');
      setPhoneInput(data.phone ?? '');
      setNotifAll(      data.notif_all       ?? true);
      setNotifComments( data.notif_comments  ?? true);
      setNotifLikes(    data.notif_likes     ?? true);
      setNotifFollowers(data.notif_followers ?? true);
      setNotifMessages( data.notif_messages  ?? true);
      setCommentPerm(   data.comment_permission ?? 'everyone');
      setShowLikes(     data.show_likes      ?? true);
    }
  }

  async function saveNotif(field, value) {
    if (!currentUser) return;
    setSavingNotif(true);
    await supabase.from('profiles').update({ [field]: value }).eq('id', currentUser.id);
    setSavingNotif(false);
  }

  async function savePrivacy(field, value) {
    if (!currentUser) return;
    setSavingPrivacy(true);
    await supabase.from('profiles').update({ [field]: value }).eq('id', currentUser.id);
    setSavingPrivacy(false);
  }

  async function savePhone() {
    if (!currentUser) return;
    setSavingPhone(true);
    await supabase.from('profiles').update({ phone: phoneInput }).eq('id', currentUser.id);
    setPhone(phoneInput);
    setSavingPhone(false);
    setEditingPhone(false);
    Alert.alert('Saved ✓', 'Phone number updated successfully.');
  }

  async function loadBlockedUsers() {
    if (!currentUser) return;
    setBlockedLoading(true);
    const { data } = await supabase
      .from('blocks')
      .select('blocked_id, profiles!blocks_blocked_id_fkey(id, username, full_name, avatar_url)')
      .eq('blocker_id', currentUser.id)
      .order('created_at', { ascending: false });
    setBlockedUsers(data?.map(d => d.profiles).filter(Boolean) ?? []);
    setBlockedLoading(false);
  }

  async function unblockUser(userId, username) {
    Alert.alert(`Unblock @${username}?`, 'They will be able to see your content and follow you again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unblock', onPress: async () => {
        await supabase.from('blocks').delete().eq('blocker_id', currentUser.id).eq('blocked_id', userId);
        setBlockedUsers(prev => prev.filter(u => u.id !== userId));
      }},
    ]);
  }

  async function handleLogout() { setShowLogoutModal(true); }

  async function confirmLogout() {
    setShowLogoutModal(false);
    await userCache.clear();
    clearFeedCache();
    await supabase.auth.signOut({ scope: 'local' });
  }

  async function handleDeleteAccount() {
    Alert.alert('Delete Account', 'This will permanently delete your account, videos, comments, and all data. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete Forever', style: 'destructive', onPress: async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error('No active session');
          const response = await fetch('https://waurtjtnyinncbdhfydu.supabase.co/functions/v1/delete-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Deletion failed');
          await userCache.clear();
          await supabase.auth.signOut();
        } catch (error) {
          Alert.alert('Error', error.message || 'Something went wrong. Please try again.');
        }
      }},
    ]);
  }

  async function handleResetPassword() {
    Alert.alert('Reset Password', 'Send a password reset link to your email?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send Link', onPress: async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.email) {
          await supabase.auth.resetPasswordForEmail(user.email);
          Alert.alert('Sent! ✉️', 'Check your email for the reset link.');
        }
      }},
    ]);
  }

  const logoutModal = (
    <Modal visible={showLogoutModal} transparent animationType="fade" onRequestClose={() => setShowLogoutModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalIcon}>🚪</Text>
          <Text style={styles.modalTitle}>Log Out</Text>
          <Text style={styles.modalMessage}>Are you sure you want to log out?</Text>
          <View style={styles.modalActions}>
            <AnimatedButton label="Cancel"  outline onPress={() => setShowLogoutModal(false)} />
            <AnimatedButton label="Log Out" danger  onPress={confirmLogout} />
          </View>
        </View>
      </View>
    </Modal>
  );

  if (screen === 'account') return (
    <SubScreen title="Account" onBack={() => setScreen(null)} insets={insets}>
      <GroupLabel text="PROFILE" />
      <Card>
        <Row icon="✏️" label="Edit Profile" sublabel="Name, bio, photo" onPress={() => { setScreen(null); navigation.navigate('EditProfile'); }} />
        <Row icon="🔑" label="Change Password" sublabel="Send a reset link to your email" onPress={handleResetPassword} />
        <Row icon="📧" label="Email Address" sublabel={currentUser?.email ?? 'Not set'} onPress={() => Alert.alert('Email', 'To change your email, please contact support.')} last />
      </Card>
      <GroupLabel text="PHONE NUMBER" />
      <Card>
        {editingPhone ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.phoneEditWrap}>
              <TextInput
                style={styles.phoneInput} value={phoneInput} onChangeText={setPhoneInput}
                placeholder="+63 900 000 0000" placeholderTextColor={SUBTEXT}
                keyboardType="phone-pad" autoFocus
              />
              <View style={styles.phoneActions}>
                <TouchableOpacity style={styles.phoneCancelBtn} onPress={() => { setPhoneInput(phone); setEditingPhone(false); }}>
                  <Text style={styles.phoneCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.phoneSaveBtn} onPress={savePhone} disabled={savingPhone}>
                  {savingPhone ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.phoneSaveText}>Save</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        ) : (
          <Row icon="📱" label="Phone Number" sublabel={phone || 'Tap to add a phone number'} onPress={() => setEditingPhone(true)} last />
        )}
      </Card>
      <GroupLabel text="LINKED ACCOUNTS" />
      <Card>
        <Row icon="🔄" label="Switch Account" sublabel="Manage multiple accounts" onPress={() => Alert.alert('Switch Account', 'Multiple account support coming soon!')} />
        <Row icon="➕" label="Add Account" sublabel="Log in to another account" onPress={() => Alert.alert('Add Account', 'Multiple account support coming soon!')} last />
      </Card>
      <GroupLabel text="DANGER ZONE" />
      <Card>
        <Row icon="🚪" label="Log Out" onPress={handleLogout} danger />
        <Row icon="🗑️" label="Delete Account" sublabel="Permanently remove your account" onPress={handleDeleteAccount} danger last />
      </Card>
    </SubScreen>
  );

  if (screen === 'privacy') return (
    <SubScreen title="Privacy & Safety" onBack={() => setScreen(null)} insets={insets}>
      <SavingBanner visible={savingPrivacy} />
      <GroupLabel text="COMMENTS" />
      <Text style={styles.sectionDesc}>Choose who can comment on your videos.</Text>
      <Card>
        {[
          { value: 'everyone',  icon: '🌍', label: 'Everyone',       sub: 'Anyone can comment on your videos' },
          { value: 'followers', icon: '👥', label: 'Followers only', sub: 'Only your followers can comment' },
          { value: 'none',      icon: '🚫', label: 'No one',         sub: 'Disable all comments' },
        ].map((opt, i, arr) => (
          <React.Fragment key={opt.value}>
            <TouchableOpacity style={styles.row} onPress={() => { setCommentPerm(opt.value); savePrivacy('comment_permission', opt.value); }}>
              <View style={[styles.rowIcon, { backgroundColor: ACCENT_DIM }]}><Text style={{ fontSize: 17 }}>{opt.icon}</Text></View>
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>{opt.label}</Text>
                <Text style={styles.rowSub}>{opt.sub}</Text>
              </View>
              <View style={styles.rowEnd}>
                {commentPerm === opt.value
                  ? <View style={styles.radioSelected}><View style={styles.radioInner} /></View>
                  : <View style={styles.radioEmpty} />}
              </View>
            </TouchableOpacity>
            {i < arr.length - 1 && <View style={styles.rowDivider} />}
          </React.Fragment>
        ))}
      </Card>
      <GroupLabel text="CONTENT" />
      <Card>
        <Row icon="❤️" label="Show Like Count" sublabel="Let others see your video like counts"
          right={<ASwitch value={showLikes} onValueChange={v => { setShowLikes(v); savePrivacy('show_likes', v); }} />} last />
      </Card>
      <GroupLabel text="SAFETY" />
      <Card>
        <Row icon="🚫" label="Blocked Users" sublabel="Manage accounts you've blocked"
          onPress={() => { setScreen('blocked'); loadBlockedUsers(); }} last />
      </Card>
    </SubScreen>
  );

  if (screen === 'blocked') return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={() => setScreen('privacy')} style={styles.subBack}>
          <Text style={styles.subBackIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.subTitle}>Blocked Users</Text>
        <View style={{ width: 44 }} />
      </View>
      {blockedLoading ? (
        <View style={styles.centered}><ActivityIndicator color={ACCENT} size="large" /></View>
      ) : blockedUsers.length === 0 ? (
        <View style={styles.centered}>
          <Text style={{ fontSize: 40, marginBottom: 12 }}>🚫</Text>
          <Text style={styles.emptyTitle}>No blocked users</Text>
          <Text style={styles.emptySubtitle}>Accounts you block will appear here</Text>
        </View>
      ) : (
        <FlatList
          data={blockedUsers} keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          renderItem={({ item }) => (
            <View style={styles.blockedRow}>
              <View style={styles.blockedAvatar}>
                {item.avatar_url
                  ? <Image source={{ uri: item.avatar_url }} style={styles.blockedAvatarImg} />
                  : <Text style={{ fontSize: 22, color: TEXT }}>{item.username?.[0]?.toUpperCase()}</Text>}
              </View>
              <View style={styles.blockedInfo}>
                <Text style={styles.blockedName}>{item.full_name || item.username}</Text>
                <Text style={styles.blockedHandle}>@{item.username}</Text>
              </View>
              <TouchableOpacity style={styles.unblockBtn} onPress={() => unblockUser(item.id, item.username)}>
                <Text style={styles.unblockText}>Unblock</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );

  if (screen === 'notifications') return (
    <SubScreen title="Notifications" onBack={() => setScreen(null)} insets={insets}>
      <SavingBanner visible={savingNotif} />
      <GroupLabel text="GENERAL" />
      <Card>
        <Row icon="🔔" label="All Notifications" sublabel="Master toggle — turns everything on or off"
          right={<ASwitch value={notifAll} onValueChange={v => { setNotifAll(v); saveNotif('notif_all', v); }} />} last />
      </Card>
      <GroupLabel text="ACTIVITY" />
      <Card>
        <Row icon="💬" label="Comments" sublabel="When someone comments on your video"
          right={<ASwitch value={notifComments} onValueChange={v => { setNotifComments(v); saveNotif('notif_comments', v); }} />} />
        <Row icon="❤️" label="Likes" sublabel="When someone likes your video"
          right={<ASwitch value={notifLikes} onValueChange={v => { setNotifLikes(v); saveNotif('notif_likes', v); }} />} />
        <Row icon="👥" label="New Followers" sublabel="When someone follows you"
          right={<ASwitch value={notifFollowers} onValueChange={v => { setNotifFollowers(v); saveNotif('notif_followers', v); }} />} />
        <Row icon="✉️" label="Direct Messages" sublabel="When someone sends you a message"
          right={<ASwitch value={notifMessages} onValueChange={v => { setNotifMessages(v); saveNotif('notif_messages', v); }} />} last />
      </Card>
    </SubScreen>
  );

  if (screen === 'appearance') return (
    <SubScreen title="Appearance" onBack={() => setScreen(null)} insets={insets}>
      <GroupLabel text="THEME" />
      <Card>
        <Row icon={isDark ? '🌙' : '☀️'} label="Dark Mode"
          sublabel={isDark ? 'Currently using dark theme' : 'Currently using light theme'}
          right={<ThemeToggle isDark={isDark} onToggle={() => setIsDark(p => !p)} />} last />
      </Card>
    </SubScreen>
  );

  if (screen === 'help') return (
    <SubScreen title="Help & Support" onBack={() => setScreen(null)} insets={insets}>
      <GroupLabel text="SUPPORT" />
      <Card>
        <Row icon="❓" label="FAQ" sublabel="Frequently asked questions" onPress={() => setScreen('faq')} />
        <Row icon="📩" label="Contact Us" sublabel="Report a problem or send feedback" onPress={() => setScreen('contact')} last />
      </Card>
      <GroupLabel text="LEGAL" />
      <Card>
        <Row icon="📄" label="Terms of Service" onPress={() => setScreen('terms')} />
        <Row icon="🔏" label="Privacy Policy" onPress={() => setScreen('privacypolicy')} sublabel="https://sites.google.com/view/bushrann" last />
      </Card>
      <GroupLabel text="APP INFO" />
      <Card>
        <Row icon="📱" label="About Bushrann" sublabel="Version 1.0.0"
          onPress={() => Alert.alert('Bushrann', 'Version 1.0.0\n\nA platform for sharing Islamic knowledge and connecting with scholars.\n\nMade with ❤️')} last />
      </Card>
    </SubScreen>
  );

  if (screen === 'faq') return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={() => setScreen('help')} style={styles.subBack}><Text style={styles.subBackIcon}>‹</Text></TouchableOpacity>
        <Text style={styles.subTitle}>FAQ</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.subScroll, { paddingBottom: insets.bottom + 40 }]}>
        {[
          { q: 'How do I apply as a scholar?',      a: 'Go to your Profile, tap the "🎓 Apply as Scholar" button, and fill in the application form.' },
          { q: 'How do I delete a video?',           a: 'Go to your profile, long-press any video, and select "Delete" from the options.' },
          { q: 'How do I report a video or user?',   a: "Tap the share icon on any video or visit a user's profile and tap \"Report\"." },
          { q: 'How do I block someone?',            a: 'Visit their profile, tap the three dots (⋯) in the top right, and select "Block".' },
          { q: "Why can't I upload a video?",        a: 'Make sure you have a stable internet connection and that your video is in MP4 format under 500MB.' },
          { q: 'How do I change my username?',       a: 'Go to Settings → Account → Edit Profile to update your username.' },
          { q: 'How do I turn off notifications?',   a: 'Go to Settings → Notifications and toggle off any notifications you want to disable.' },
        ].map((item, i) => (
          <View key={i} style={styles.faqItem}>
            <Text style={styles.faqQ}>Q: {item.q}</Text>
            <Text style={styles.faqA}>{item.a}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );

  if (screen === 'contact') return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={() => setScreen('help')} style={styles.subBack}><Text style={styles.subBackIcon}>‹</Text></TouchableOpacity>
        <Text style={styles.subTitle}>Contact Us</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.subScroll, { paddingBottom: insets.bottom + 40 }]}>
        <Text style={styles.contactIntro}>Have a question, found a bug, or want to give feedback? We'd love to hear from you.</Text>
        <GroupLabel text="REACH US AT" />
        <Card>
          <Row icon="📧" label="Email Support" sublabel="support@bushrann.app"
            onPress={() => Alert.alert('Email Us', 'Send us an email at support@bushrann.app')} last />
        </Card>
        <GroupLabel text="RESPONSE TIME" />
        <View style={styles.infoBox}>
          <Text style={styles.infoBoxText}>We typically respond within 24–48 hours on business days.</Text>
        </View>
      </ScrollView>
    </View>
  );

  if (screen === 'terms') return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={() => setScreen('help')} style={styles.subBack}><Text style={styles.subBackIcon}>‹</Text></TouchableOpacity>
        <Text style={styles.subTitle}>Terms of Service</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.subScroll, { paddingBottom: insets.bottom + 40 }]}>
        <View style={styles.legalHeader}>
          <Text style={styles.legalAppName}>Balagh</Text>
          <Text style={styles.legalEffective}>Effective Date: March 1, 2026</Text>
        </View>
        {[
          { title: '1. Acceptance of Terms', body: 'By downloading, installing, accessing, or using the Balagh mobile application, you agree to be bound by these Terms of Service and our Privacy Policy. These Terms constitute a legally binding agreement governed by the laws of the Republic of the Philippines. If you do not agree, you must immediately cease use of the App.' },
          { title: '2. Eligibility', body: 'You must be at least thirteen (13) years of age to use the Service. If you are under eighteen (18), you represent that you have obtained parental or guardian consent. You must have the legal capacity to enter into a binding contract and must not be barred from using the Service under Philippine law or any applicable jurisdiction.' },
          { title: '3. User Accounts', body: 'You must provide accurate, current, and complete information when creating an account. You are responsible for maintaining the confidentiality of your credentials and for all activities under your account. Scholar status is granted at the sole discretion of the Company. Misrepresentation of credentials in a scholar application constitutes fraud and may result in immediate account termination and referral to legal authorities.' },
          { title: '4. Prohibited Activities', body: 'You agree not to: post unlawful, defamatory, obscene, or harassing content; infringe upon intellectual property rights under Republic Act No. 8293 (Intellectual Property Code); engage in cyberbullying or harassment prohibited under Republic Act No. 10175 (Cybercrime Prevention Act of 2012); collect personal data without consent in violation of Republic Act No. 10173 (Data Privacy Act of 2012); spread misinformation that could incite violence; or attempt unauthorized access to the Service or any connected system.' },
          { title: '5. Content Ownership & License', body: 'You retain ownership of content you submit. By posting, you grant Balagh a non-exclusive, worldwide, royalty-free license to use, reproduce, and display your content in connection with the Service. We reserve the right to remove content that violates these Terms or applicable law without liability.' },
          { title: '6. Privacy', body: 'Your use of the Service is governed by our Privacy Policy, incorporated herein by reference. By using the Service, you consent to the collection, use, and sharing of your information in compliance with Republic Act No. 10173 (Data Privacy Act of 2012) and its Implementing Rules and Regulations.' },
          { title: '7. Disclaimer of Warranties', body: 'THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS.' },
          { title: '8. Limitation of Liability', body: 'TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, BALAGH SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE SERVICE. Nothing herein limits liability for gross negligence, fraud, or willful misconduct under applicable Philippine law.' },
          { title: '9. Indemnification', body: 'You agree to defend, indemnify, and hold harmless Balagh and its officers, directors, and employees from claims, liabilities, and expenses arising from your use of the Service, your posted content, your violation of these Terms, or your violation of applicable law or the rights of any third party.' },
          { title: '10. Governing Law & Dispute Resolution', body: 'These Terms are governed by the laws of the Republic of the Philippines. Any dispute shall be submitted to the exclusive jurisdiction of the proper courts of Davao City, Philippines. Prior to legal proceedings, parties agree to attempt good-faith negotiation for thirty (30) days.' },
          { title: '11. Modifications', body: 'We reserve the right to modify these Terms at any time. We will notify registered users of material changes at least fifteen (15) days prior to the effective date via email or in-app notification. Continued use of the Service after the effective date constitutes acceptance of the modified Terms.' },
          { title: '12. Contact', body: 'For questions regarding these Terms, contact us at:\n\nBalagh\nEmail: bushrann.app@gmail.com' },
        ].map((s, i) => (
          <View key={i} style={styles.legalSection}>
            <Text style={styles.legalTitle}>{s.title}</Text>
            <Text style={styles.legalBody}>{s.body}</Text>
          </View>
        ))}
        <View style={styles.legalFooter}>
          <Text style={styles.legalFooterText}>© 2026 Balagh. All rights reserved.</Text>
          <Text style={[styles.legalFooterText, { marginTop: 4 }]}>Compliant with RA 10173 · RA 10175 · RA 8293</Text>
        </View>
      </ScrollView>
    </View>
  );

  if (screen === 'privacypolicy') return (
    <View style={[styles.subContainer, { paddingTop: insets.top }]}>
      <View style={styles.subHeader}>
        <TouchableOpacity onPress={() => setScreen('help')} style={styles.subBack}><Text style={styles.subBackIcon}>‹</Text></TouchableOpacity>
        <Text style={styles.subTitle}>Privacy Policy</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={[styles.subScroll, { paddingBottom: insets.bottom + 40 }]}>
        <View style={styles.legalHeader}>
          <Text style={styles.legalAppName}>Balagh</Text>
          <Text style={styles.legalEffective}>Effective Date: March 1, 2026</Text>
        </View>
        <Text style={styles.legalIntro}>
          This Privacy Policy describes how Balagh collects, uses, stores, and discloses personal information in compliance with Republic Act No. 10173 (Data Privacy Act of 2012), its Implementing Rules and Regulations, directives of the National Privacy Commission (NPC), and, where applicable, the EU General Data Protection Regulation (GDPR).
        </Text>
        {[
          { title: '1. Information We Collect', body: 'We collect: (a) account information you provide such as username, email, password, and profile photo; (b) scholar application information including your real name, age, location, education, and expertise; (c) user-generated content such as videos, comments, and likes; (d) device information, usage data, and log data collected automatically when you use the Service.' },
          { title: '2. Legal Basis for Processing', body: 'We process your personal information based on: (a) your consent (Section 12(a), DPA; Article 6(1)(a), GDPR); (b) contractual necessity to provide the Service (Section 12(b), DPA; Article 6(1)(b), GDPR); (c) legal obligations (Section 12(c), DPA; Article 6(1)(c), GDPR); and (d) legitimate interests in operating and improving the platform (Section 12(f), DPA; Article 6(1)(f), GDPR).' },
          { title: '3. How We Use Your Information', body: 'We use your information to: create and manage your account; provide and improve the Service; process scholar verification applications; enable user interactions; send administrative communications; detect and prevent fraud and illegal activities; comply with legal obligations including NPC directives; and respond to your inquiries.' },
          { title: '4. Disclosure of Information', body: 'We do not sell your personal information. We may share information with: trusted service providers under confidentiality obligations; law enforcement or courts when required by Philippine law or NPC order; successor entities in a business transfer subject to data protection obligations; or third parties with your explicit consent.' },
          { title: '5. Scholar Profile Information', body: 'If you are a verified scholar, your full name, age, location, educational background, and expertise will be displayed publicly on your profile. By accepting scholar status, you expressly consent to this public display in accordance with the Data Privacy Act of 2012.' },
          { title: '6. Data Retention', body: 'We retain your personal information for as long as your account is active or as needed to provide the Service and comply with legal obligations. Upon account deletion, your personal data will be deleted within sixty (60) days, except where retention is required by law, in accordance with Section 11 of the DPA.' },
          { title: '7. Data Security', body: 'We implement appropriate technical and organizational security measures as required under Section 20 of the DPA, including encryption and access controls. In the event of a personal data breach, we will comply with mandatory notification requirements under the DPA and NPC regulations.' },
          { title: '8. Your Rights as a Data Subject', body: 'Under the Data Privacy Act of 2012 and the GDPR, you have the right to:\n\n• Be Informed — how your data is processed (Sec. 16(a), DPA)\n• Access — request a copy of your personal data (Sec. 16(b), DPA; Art. 15, GDPR)\n• Rectification — correct inaccurate data (Sec. 16(e), DPA; Art. 16, GDPR)\n• Erasure — request deletion of your data (Sec. 16(c), DPA; Art. 17, GDPR)\n• Object — to processing of your data (Sec. 16(d), DPA; Art. 21, GDPR)\n• Data Portability — receive your data in a portable format (Sec. 18, DPA; Art. 20, GDPR)\n• Damages — be indemnified for unlawful processing (Sec. 16(f), DPA)\n• File a Complaint — with the NPC at www.privacy.gov.ph' },
          { title: '9. Data Protection Officer', body: 'In compliance with Section 21 of the Data Privacy Act of 2012, Balagh has designated a Data Protection Officer (DPO).\n\nData Protection Officer — Balagh\nEmail: bushrann.app@gmail.com' },
          { title: "10. Children's Privacy", body: 'The Service is not directed to children under thirteen (13). We do not knowingly collect personal information from children under 13 without verifiable parental consent, in compliance with Republic Act No. 7610 (Special Protection of Children Against Abuse, Exploitation and Discrimination Act).' },
          { title: '11. International Data Transfers', body: 'Your personal information may be processed outside the Philippines. Where such transfers occur, we ensure appropriate safeguards are in place in accordance with Section 21 of the DPA IRR and applicable international data protection standards, including the GDPR.' },
          { title: '12. Changes to This Policy', body: 'We may update this Privacy Policy from time to time. We will notify you of material changes through the App or by direct notification as required by law. Continued use of the Service after any changes constitutes acceptance of the updated Policy.' },
          { title: '13. Contact Us', body: 'For privacy-related questions or to exercise your data subject rights, contact us at:\n\nBalagh\nEmail: bushrann.app@gmail.com' },
        ].map((s, i) => (
          <View key={i} style={styles.legalSection}>
            <Text style={styles.legalTitle}>{s.title}</Text>
            <Text style={styles.legalBody}>{s.body}</Text>
          </View>
        ))}
        <View style={styles.legalFooter}>
          <Text style={styles.legalFooterText}>© 2026 Balagh. All rights reserved.</Text>
          <Text style={[styles.legalFooterText, { marginTop: 4 }]}>Compliant with RA 10173 · RA 10175 · GDPR · RA 7610</Text>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {logoutModal}
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}>
        <View style={styles.profileCard}>
          <View style={styles.profileAvatarWrap}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={styles.profileAvatar} />
            ) : (
              <View style={styles.profileAvatarFallback}>
                <Text style={{ fontSize: 30, color: '#fff' }}>{profile?.username?.[0]?.toUpperCase() ?? '?'}</Text>
              </View>
            )}
            <View style={styles.profileOnline} />
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{profile?.full_name || profile?.username || 'Your Name'}</Text>
            <Text style={styles.profileHandle}>@{profile?.username || 'yourhandle'}</Text>
          </View>
          <TouchableOpacity style={styles.profileEditBtn} onPress={() => navigation.navigate('EditProfile')}>
            <Text style={styles.profileEditText}>Edit Profile</Text>
          </TouchableOpacity>
        </View>
        <GroupLabel text="PREFERENCES" />
        <Card>
          <CategoryButton icon="👤" label="Account"          sublabel="Profile, password, phone number"      onPress={() => setScreen('account')} />
          <CategoryButton icon="🔒" label="Privacy & Safety" sublabel="Comments, blocked users, like count"  onPress={() => setScreen('privacy')} />
          <CategoryButton icon="🔔" label="Notifications"    sublabel="Likes, comments, followers, messages" onPress={() => setScreen('notifications')} />
          <CategoryButton icon="🎨" label="Appearance"       sublabel="Dark mode & theme"                    onPress={() => setScreen('appearance')} />
          <CategoryButton icon="💬" label="Help & Support"   sublabel="FAQ, contact us, terms, about"        onPress={() => setScreen('help')} last />
        </Card>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutIcon}>🚪</Text>
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: BG },
  subContainer: { flex: 1, backgroundColor: BG },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: BORDER },
  backBtn:     { width: 44, alignItems: 'flex-start', justifyContent: 'center' },
  backIcon:    { fontSize: 34, color: TEXT, lineHeight: 36, fontWeight: '200' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: TEXT, letterSpacing: 0.3 },
  scroll:      { paddingHorizontal: 16, paddingTop: 20 },
  profileCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, borderRadius: 20, padding: 16, marginBottom: 28, borderWidth: 0.5, borderColor: BORDER },
  profileAvatarWrap:     { position: 'relative', marginRight: 14 },
  profileAvatar:         { width: 58, height: 58, borderRadius: 29, borderWidth: 2, borderColor: ACCENT },
  profileAvatarFallback: { width: 58, height: 58, borderRadius: 29, backgroundColor: COLORS.navyLight, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: ACCENT },
  profileOnline:         { position: 'absolute', bottom: 1, right: 1, width: 13, height: 13, borderRadius: 7, backgroundColor: COLORS.success, borderWidth: 2, borderColor: CARD },
  profileInfo:           { flex: 1 },
  profileName:           { fontSize: 16, fontWeight: '700', color: TEXT },
  profileHandle:         { fontSize: 13, color: ACCENT, marginTop: 2 },
  profileEditBtn:        { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: ACCENT, minHeight: 36, justifyContent: 'center' },
  profileEditText:       { fontSize: 13, fontWeight: '600', color: ACCENT },
  groupLabel:  { fontSize: 12, fontWeight: '800', letterSpacing: 1.8, color: SUBTEXT, marginBottom: 10, marginLeft: 4 },
  sectionDesc: { fontSize: 13, color: SUBTEXT, marginBottom: 12, marginLeft: 4, lineHeight: 19 },
  card: { backgroundColor: CARD, borderRadius: 18, borderWidth: 0.5, borderColor: BORDER, overflow: 'hidden', marginBottom: 24 },
  catRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16 },
  catIcon:    { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  catBody:    { flex: 1 },
  catLabel:   { fontSize: 16, fontWeight: '600', color: TEXT },
  catSub:     { fontSize: 12, color: SUBTEXT, marginTop: 3 },
  catChevron: { fontSize: 24, color: '#ccc', fontWeight: '300' },
  catDivider: { height: 0.5, backgroundColor: BORDER, marginLeft: 76 },
  row:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  rowIcon:   { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 14 },
  rowBody:   { flex: 1 },
  rowLabel:  { fontSize: 15, fontWeight: '600', color: TEXT },
  rowSub:    { fontSize: 12, color: SUBTEXT, marginTop: 2 },
  rowEnd:    { marginLeft: 8 },
  chevron:   { fontSize: 22, color: '#ccc', fontWeight: '300' },
  rowDivider: { height: 0.5, backgroundColor: BORDER, marginLeft: 70 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: DANGER + '10', borderRadius: 16, paddingVertical: 15, borderWidth: 1, borderColor: DANGER + '30', gap: 10, marginTop: 4, marginBottom: 8 },
  logoutIcon: { fontSize: 18 },
  logoutText: { fontSize: 16, fontWeight: '700', color: DANGER },
  subHeader:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5, borderBottomColor: BORDER },
  subBack:     { width: 44, alignItems: 'flex-start', justifyContent: 'center' },
  subBackIcon: { fontSize: 34, color: TEXT, lineHeight: 36, fontWeight: '200' },
  subTitle:    { fontSize: 17, fontWeight: '700', color: TEXT, letterSpacing: 0.3 },
  subScroll:   { paddingHorizontal: 16, paddingTop: 20 },
  radioSelected: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  radioInner:    { width: 11, height: 11, borderRadius: 6, backgroundColor: ACCENT },
  radioEmpty:    { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: MUTED },
  savingBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8, marginBottom: 12, backgroundColor: ACCENT_DIM, borderRadius: 12 },
  savingText:   { color: ACCENT, fontSize: 13, fontWeight: '600' },
  phoneEditWrap:   { padding: 16 },
  phoneInput:      { backgroundColor: '#fff', borderRadius: 12, borderWidth: 0.5, borderColor: BORDER, color: TEXT, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 12 },
  phoneActions:    { flexDirection: 'row', gap: 10 },
  phoneCancelBtn:  { flex: 1, paddingVertical: 11, borderRadius: 12, borderWidth: 0.5, borderColor: BORDER, alignItems: 'center' },
  phoneCancelText: { color: SUBTEXT, fontWeight: '600' },
  phoneSaveBtn:    { flex: 1, paddingVertical: 11, borderRadius: 12, backgroundColor: ACCENT, alignItems: 'center' },
  phoneSaveText:   { color: '#fff', fontWeight: '700', fontSize: 15 },
  centered:       { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  emptyTitle:     { fontSize: 18, fontWeight: '700', color: TEXT, marginBottom: 6 },
  emptySubtitle:  { fontSize: 14, color: SUBTEXT },
  blockedRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, borderRadius: 16, padding: 14, marginBottom: 10, borderWidth: 0.5, borderColor: BORDER },
  blockedAvatar:  { width: 46, height: 46, borderRadius: 23, backgroundColor: MUTED, alignItems: 'center', justifyContent: 'center', marginRight: 12, overflow: 'hidden' },
  blockedAvatarImg: { width: 46, height: 46, borderRadius: 23 },
  blockedInfo:    { flex: 1 },
  blockedName:    { fontSize: 15, fontWeight: '700', color: TEXT },
  blockedHandle:  { fontSize: 12, color: SUBTEXT, marginTop: 2 },
  unblockBtn:     { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: ACCENT, minHeight: 36, justifyContent: 'center' },
  unblockText:    { color: ACCENT, fontSize: 13, fontWeight: '600' },
  faqItem: { backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 0.5, borderColor: BORDER },
  faqQ:    { fontSize: 15, fontWeight: '700', color: TEXT, marginBottom: 8 },
  faqA:    { fontSize: 14, color: SUBTEXT, lineHeight: 21 },
  contactIntro: { fontSize: 15, color: SUBTEXT, lineHeight: 22, marginBottom: 24 },
  infoBox:      { backgroundColor: CARD, borderRadius: 14, padding: 16, borderWidth: 0.5, borderColor: BORDER },
  infoBoxText:  { color: SUBTEXT, fontSize: 14, lineHeight: 21 },
  legalHeader:     { backgroundColor: CARD, borderRadius: 16, padding: 20, marginBottom: 20, borderWidth: 0.5, borderColor: BORDER, alignItems: 'center' },
  legalAppName:    { fontSize: 26, fontWeight: '800', color: ACCENT, marginBottom: 6 },
  legalEffective:  { fontSize: 13, color: SUBTEXT, fontStyle: 'italic' },
  legalIntro:      { fontSize: 14, color: SUBTEXT, lineHeight: 22, marginBottom: 16 },
  legalSection:    { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 0.5, borderColor: BORDER },
  legalTitle:      { fontSize: 14, fontWeight: '700', color: ACCENT, marginBottom: 8 },
  legalBody:       { fontSize: 13, color: SUBTEXT, lineHeight: 22 },
  legalFooter:     { alignItems: 'center', paddingVertical: 24 },
  legalFooterText: { fontSize: 12, color: '#ccc', textAlign: 'center' },
  toggleTrack: { width: 52, height: 28, borderRadius: 14, justifyContent: 'center' },
  toggleKnob:  { position: 'absolute', width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  modalOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  modalBox:            { backgroundColor: '#fff', borderRadius: 24, padding: 28, alignItems: 'center', width: '100%', borderWidth: 0.5, borderColor: BORDER },
  modalIcon:           { fontSize: 40, marginBottom: 12 },
  modalTitle:          { fontSize: 20, fontWeight: '800', color: TEXT, marginBottom: 8 },
  modalMessage:        { fontSize: 14, color: SUBTEXT, textAlign: 'center', lineHeight: 21, marginBottom: 24 },
  modalActions:        { flexDirection: 'row', gap: 12, width: '100%' },
  modalBtn:            { paddingVertical: 14, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: ACCENT },
  modalBtnDanger:      { backgroundColor: DANGER },
  modalBtnOutline:     { backgroundColor: 'transparent', borderWidth: 1, borderColor: BORDER },
  modalBtnText:        { fontSize: 15, fontWeight: '700', color: '#fff' },
  modalBtnTextDanger:  { color: '#fff' },
  modalBtnTextOutline: { color: SUBTEXT },
});