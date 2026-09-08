import { inject } from '@vercel/analytics';
import { nowPlaying, playlists, tracks } from '../data/spotify';
import type { Track } from '../types/library';

inject();

type LyricLine = { time: number; element: HTMLButtonElement };
type ViewState = { view: 'home' | 'search' | 'playlist' | 'lyrics'; playlistId?: string };
type LikeState = { count: number; liked: boolean; configured?: boolean };

const app = document.querySelector<HTMLElement>('[data-music-app]');

if (app) {
  const audio = document.querySelector<HTMLAudioElement>('[data-audio]');
  const nowVideo = document.querySelector<HTMLVideoElement>('[data-now-video]');
  const homeView = document.querySelector<HTMLElement>('[data-home-view]');
  const lyricsView = document.querySelector<HTMLElement>('[data-lyrics-view]');
  const lyricsContainer = document.querySelector<HTMLElement>('[data-lyrics-lines]');
  const lyricsEmpty = document.querySelector<HTMLElement>('[data-lyrics-empty]');
  const lyricsScroll = document.querySelector<HTMLElement>('[data-lyrics-scroll]');
  const main = document.querySelector<HTMLElement>('main');
  const searchView = document.querySelector<HTMLElement>('[data-search-view]');
  const searchResults = document.querySelector<HTMLElement>('[data-search-results]');
  const searchSummary = document.querySelector<HTMLElement>('[data-search-summary]');
  const searchInput = document.querySelector<HTMLInputElement>('[data-search-input]');
  const searchClear = document.querySelector<HTMLButtonElement>('[data-search-clear]');
  const playlistViews = Array.from(document.querySelectorAll<HTMLElement>('[data-playlist-view]'));

  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const playlistById = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const initialTrackId = app.dataset.initialTrackId || new URLSearchParams(window.location.search).get('track') || new URLSearchParams(window.location.search).get('song');
  let currentTrack = (initialTrackId ? trackById.get(initialTrackId) : null) ?? nowPlaying;
  let isPlaying = false;
  let lyricLines: LyricLine[] = [];
  let activeLyricIndex = -1;
  let likeRequestId = 0;
  let likeRequestPending = false;
  let isSeeking = false;
  let progressRafId: number | null = null;
  let currentPlaylist: (typeof playlists)[number] | null = null;
  const all = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
  const setText = (selector: string, value: string) => all<HTMLElement>(selector).forEach((element) => { element.textContent = value; });
  const setImage = (selector: string, track: Track) => all<HTMLImageElement>(selector).forEach((image) => {
    image.src = track.cover;
    image.alt = `${track.title} cover`;
    image.classList.remove('animate-fade-quick');
    void image.offsetWidth;
    image.classList.add('animate-fade-quick');
  });
  const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  const renderLikeState = (state: LikeState, pending = false) => {
    const available = state.configured !== false;
    all<HTMLButtonElement>('[data-like-button]').forEach((button) => {
      button.disabled = pending || !available;
      button.setAttribute('aria-busy', String(pending));
      button.setAttribute('aria-pressed', String(state.liked));
      button.setAttribute('aria-label', available ? `${state.liked ? 'Unlike' : 'Like'} ${currentTrack.title}` : 'Likes are unavailable until Redis is configured');
      button.classList.toggle('text-lime', state.liked);
    });
    all<SVGElement>('[data-like-icon]').forEach((icon) => {
      icon.classList.toggle('fill-[#1ed760]', state.liked);
      if (state.liked && !pending) {
        icon.classList.remove('animate-heart-pop');
        void (icon as unknown as HTMLElement).offsetWidth;
        icon.classList.add('animate-heart-pop');
      }
    });
    setText('[data-like-count]', String(state.count));
  };

  const setLikeStatus = (message: string) => setText('[data-like-status]', message);

  const requestLikeState = async (method: 'GET' | 'POST') => {
    const track = currentTrack;
    const requestId = ++likeRequestId;
    likeRequestPending = true;
    renderLikeState({ count: Number(all<HTMLElement>('[data-like-count]')[0]?.textContent) || 0, liked: false }, true);
    setLikeStatus(method === 'GET' ? 'Loading likes' : 'Updating like');

    try {
      const response = await fetch(`/api/likes/${encodeURIComponent(track.id)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`Like request failed with status ${response.status}`);
      const state = await response.json() as LikeState;
      if (requestId !== likeRequestId || track.id !== currentTrack.id) return;
      if (state.configured === false) {
        console.warn('[Spotibai] Upstash Redis is not configured in Vercel Environment Variables. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
        setLikeStatus('Likes are unavailable until Redis is configured in Vercel.');
        renderLikeState({ count: Number(all<HTMLElement>('[data-like-count]')[0]?.textContent) || 0, liked: false, configured: false }, false);
        return;
      }
      renderLikeState(state);
      setLikeStatus(`${state.count} ${state.count === 1 ? 'like' : 'likes'}; ${state.liked ? 'liked' : 'not liked'}`);
    } catch (error) {
      console.error('[Spotibai] Like request failed', error);
      if (requestId !== likeRequestId || track.id !== currentTrack.id) return;
      renderLikeState({ count: Number(all<HTMLElement>('[data-like-count]')[0]?.textContent) || 0, liked: false });
      setLikeStatus(method === 'GET' ? 'Could not load likes' : 'Could not update like');
    } finally {
      if (requestId === likeRequestId) likeRequestPending = false;
    }
  };

  const hideViews = () => {
    homeView?.classList.add('hidden');
    lyricsView?.classList.add('hidden');
    searchView?.classList.add('hidden');
    playlistViews.forEach((view) => view.classList.add('hidden'));
  };

  const storeView = (state: ViewState) => {
    const hash = state.view === 'playlist' ? `#playlist=${state.playlistId}` : state.view === 'lyrics' ? '#lyrics' : state.view === 'search' ? '#search' : '';
    window.history.pushState(state, '', `${window.location.pathname}${hash}`);
  };

  const animateViewIn = (el: HTMLElement | null | undefined) => {
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.remove('animate-fade-in');
    void el.offsetWidth;
    el.classList.add('animate-fade-in');
  };

  const showHome = (shouldStore = false) => {
    hideViews();
    animateViewIn(homeView);
    main?.scrollTo({ top: 0 });
    if (shouldStore) storeView({ view: 'home' });
  };

  const showPlaylist = (playlistId: string, shouldStore = false) => {
    const playlistView = playlistViews.find((view) => view.dataset.playlistViewId === playlistId || view.dataset.playlistId === playlistId);
    if (!playlistView) return;
    const pl = playlistById.get(playlistId);
    if (pl) currentPlaylist = pl;
    hideViews();
    animateViewIn(playlistView);
    main?.scrollTo({ top: 0 });
    renderPlaybackState();
    if (shouldStore) storeView({ view: 'playlist', playlistId });
  };

  const showSearch = (shouldStore = false) => {
    hideViews();
    animateViewIn(searchView);
    main?.scrollTo({ top: 0 });
    if (shouldStore) storeView({ view: 'search' });
  };

  const renderPlaybackState = () => {
    all<HTMLElement>('[data-play-icon]').forEach((icon) => icon.classList.toggle('hidden', isPlaying));
    all<HTMLElement>('[data-pause-icon]').forEach((icon) => icon.classList.toggle('hidden', !isPlaying));
    all<HTMLButtonElement>('[data-play-toggle]').forEach((button) => button.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play'));
    all<HTMLButtonElement>('[data-playlist-play]').forEach((button) => {
      const plId = button.dataset.playlistPlay;
      const isThisActive = isPlaying && currentPlaylist?.id === plId;
      const playIcon = button.querySelector('[data-playlist-icon-play]');
      const pauseIcon = button.querySelector('[data-playlist-icon-pause]');
      if (playIcon) playIcon.classList.toggle('hidden', isThisActive);
      if (pauseIcon) pauseIcon.classList.toggle('hidden', !isThisActive);
      button.setAttribute('aria-label', isThisActive ? 'Pause playlist' : 'Play playlist');
    });
    all<HTMLElement>('[data-track-id]').forEach((row) => {
      const isCurrent = row.dataset.trackId === currentTrack.id;
      const titleSpan = row.querySelector('.truncate');
      if (titleSpan) {
        titleSpan.classList.toggle('text-lime', isCurrent);
      }
    });
  };

  const renderVideo = (track: Track) => {
    if (!nowVideo) return;
    const hasVideo = Boolean(track.videoSrc);
    nowVideo.classList.toggle('hidden', !hasVideo);
    all<HTMLImageElement>('[data-now-cover]').forEach((image) => image.classList.toggle('hidden', hasVideo));
    if (hasVideo) {
      nowVideo.src = track.videoSrc;
      nowVideo.load();
    }
  };

  const syncVideo = () => {
    if (!audio || !nowVideo || !currentTrack.videoSrc) return;
    if (Math.abs(nowVideo.currentTime - audio.currentTime) > 0.35) nowVideo.currentTime = audio.currentTime;
    if (isPlaying) nowVideo.play().catch(() => undefined);
    else nowVideo.pause();
  };

  const renderLyrics = () => {
    if (!audio || lyricLines.length === 0) return;
    const currentIndex = lyricLines.reduce((latestIndex, line, index) => line.time <= audio.currentTime ? index : latestIndex, -1);
    if (currentIndex === activeLyricIndex) return;
    lyricLines.forEach((line, index) => {
      const isActive = index === currentIndex;
      line.element.classList.toggle('text-white', isActive);
      line.element.classList.toggle('scale-[1.02]', isActive);
      line.element.classList.toggle('opacity-100', isActive);
      line.element.classList.toggle('text-[#c9aa9a]', !isActive);
      line.element.classList.toggle('scale-100', !isActive);
      line.element.classList.toggle('opacity-40', !isActive);
    });
    activeLyricIndex = currentIndex;
    const activeLine = lyricLines[currentIndex]?.element;
    if (activeLine && lyricsScroll && lyricsView && !lyricsView.classList.contains('hidden')) {
      lyricsScroll.scrollTo({
        top: Math.max(activeLine.offsetTop - lyricsScroll.clientHeight / 2 + activeLine.clientHeight / 2, 0),
        behavior: 'smooth',
      });
    }
  };

  const parseLrc = (source: string) => source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\[(\d+):(\d{2})\.(\d{2})\](.*)$/);
    if (!match || !match[4].trim()) return [];
    return [{ time: Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100, text: match[4].trim() }];
  });

  let lyricsRequestId = 0;

  const loadLyrics = async (track: Track) => {
    const requestId = ++lyricsRequestId;
    lyricLines = [];
    activeLyricIndex = -1;
    if (!lyricsContainer || !lyricsEmpty) return;
    lyricsContainer.replaceChildren();
    lyricsEmpty.classList.add('hidden');
    if (lyricsScroll) lyricsScroll.scrollTop = 0;

    try {
      const response = await fetch(track.lyricsSrc);
      if (!response.ok) throw new Error('Lyrics file not found');
      const text = await response.text();
      if (requestId !== lyricsRequestId || track.id !== currentTrack.id) return;
      const lines = parseLrc(text);
      if (lines.length === 0) throw new Error('Lyrics file has no timed lines');
      lyricLines = lines.map((line) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.dataset.lyricTime = String(line.time);
        element.className = 'block w-full text-left text-2xl font-bold leading-tight text-[#c9aa9a] opacity-40 scale-100 transition-all duration-300 origin-left hover:text-white hover:scale-105 active:scale-95 sm:text-5xl';
        element.textContent = line.text;
        lyricsContainer.append(element);
        return { time: line.time, element };
      });
      renderLyrics();
    } catch {
      if (requestId !== lyricsRequestId || track.id !== currentTrack.id) return;
      lyricsEmpty.classList.remove('hidden');
    }
  };

  const openLyrics = (shouldStore = false) => {
    hideViews();
    animateViewIn(lyricsView);
    main?.scrollTo({ top: 0 });
    if (lyricsScroll) lyricsScroll.scrollTop = 0;
    void loadLyrics(currentTrack);
    if (shouldStore) storeView({ view: 'lyrics' });
  };

  const handleShare = async (_button?: HTMLButtonElement) => {
    const track = currentTrack;
    const shareUrl = `${window.location.origin}/track/${encodeURIComponent(track.id)}`;
    let shared = false;

    if (navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({
          title: `${track.title} — ${track.artist}`,
          text: `Paminawa ang "${track.title}" ni ${track.artist} sa Spotibai!`,
          url: shareUrl,
        });
        shared = true;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }

    if (!shared) {
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        const temp = document.createElement('input');
        temp.value = shareUrl;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
    }

    all<HTMLElement>('[data-share-tooltip]').forEach((tip) => {
      tip.textContent = shared ? 'Shared!' : 'Link copied!';
      tip.classList.remove('opacity-0', 'pointer-events-none');
      tip.classList.add('opacity-100');
    });
    all<HTMLButtonElement>('[data-share-button]').forEach((btn) => {
      btn.classList.add('text-lime');
    });

    setTimeout(() => {
      all<HTMLElement>('[data-share-tooltip]').forEach((tip) => {
        tip.classList.add('opacity-0', 'pointer-events-none');
        tip.classList.remove('opacity-100');
      });
      all<HTMLButtonElement>('[data-share-button]').forEach((btn) => {
        btn.classList.remove('text-lime');
      });
    }, 2000);
  };

  const setRangeFill = (input: HTMLInputElement) => {
    const minimum = Number(input.min || 0);
    const maximum = Number(input.max || 100);
    const value = Number(input.value);
    const percentage = maximum > minimum ? ((value - minimum) / (maximum - minimum)) * 100 : 0;
    input.style.setProperty('--range-progress', `${Math.min(100, Math.max(0, percentage))}%`);
  };

  const updateProgress = () => {
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (!isSeeking) {
      all<HTMLInputElement>('[data-seek]').forEach((input) => {
        input.max = String(duration || 1);
        input.value = String(audio.currentTime);
        setRangeFill(input);
      });
      setText('[data-elapsed]', formatTime(audio.currentTime));
    }
    setText('[data-player-duration]', duration ? formatTime(duration) : currentTrack.duration);
  };

  const startProgressLoop = () => {
    if (progressRafId) cancelAnimationFrame(progressRafId);
    const loop = () => {
      if (isPlaying && audio && !audio.paused) {
        if (!isSeeking) {
          updateProgress();
        }
        progressRafId = requestAnimationFrame(loop);
      } else {
        progressRafId = null;
      }
    };
    progressRafId = requestAnimationFrame(loop);
  };

  const stopProgressLoop = () => {
    if (progressRafId) {
      cancelAnimationFrame(progressRafId);
      progressRafId = null;
    }
  };

  const selectTrack = (track: Track, shouldOpenLyrics = false) => {
    currentTrack = track;
    setText('[data-player-title], [data-now-title], [data-lyrics-title]', track.title);
    setText('[data-player-artist], [data-now-artist], [data-lyrics-artist]', track.artist);
    setImage('[data-player-cover], [data-now-cover], [data-lyrics-cover]', track);
    all<HTMLButtonElement>('[data-share-button]').forEach((btn) => {
      btn.setAttribute('aria-label', `Share ${track.title}`);
    });
    renderVideo(track);
    renderLikeState({ count: 0, liked: false }, true);
    void requestLikeState('GET');
    void loadLyrics(track);

    if (audio) {
      audio.pause();
      audio.src = track.audioSrc;
      audio.load();
      updateProgress();
      audio.play().then(() => { isPlaying = true; renderPlaybackState(); }).catch(() => { isPlaying = false; renderPlaybackState(); });
    }
    if (shouldOpenLyrics) {
      openLyrics(true);
    } else if (lyricsView && !lyricsView.classList.contains('hidden')) {
      if (lyricsScroll) lyricsScroll.scrollTop = 0;
    }
  };

  const renderSearchResults = (query: string) => {
    if (!searchResults || !searchSummary) return;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery ? tracks.filter((track) => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(normalizedQuery)) : [];
    searchResults.replaceChildren();
    searchSummary.textContent = normalizedQuery
      ? `${matches.length} ${matches.length === 1 ? 'result' : 'results'} for “${query.trim()}”`
      : 'Start typing to search your local music.';
    matches.forEach((track, idx) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.dataset.trackId = track.id;
      result.className = 'group flex w-full items-center gap-3.5 rounded-lg px-3 py-2.5 text-left transition-all duration-150 hover:bg-white/10 active:bg-white/15 animate-fade-quick';
      result.style.animationDelay = `${Math.min(idx * 30, 200)}ms`;
      result.setAttribute('aria-label', `Play ${track.title}`);
      const image = document.createElement('img');
      image.src = track.cover;
      image.alt = `${track.title} cover`;
      image.width = 48;
      image.height = 48;
      image.className = 'size-12 rounded-md object-cover shrink-0 shadow-sm';
      const copy = document.createElement('span');
      copy.className = 'min-w-0 flex-1';
      const title = document.createElement('span');
      title.className = 'block truncate text-sm font-semibold text-white transition-colors group-hover:text-lime';
      title.textContent = track.title;
      const artist = document.createElement('span');
      artist.className = 'block truncate text-xs text-[#b3b3b3]';
      artist.textContent = track.artist;
      copy.append(title, artist);
      const duration = document.createElement('span');
      duration.className = 'text-xs tabular-nums text-[#b3b3b3]';
      duration.textContent = track.duration;
      result.append(image, copy, duration);
      searchResults.append(result);
    });
  };

  const togglePlayback = () => {
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => undefined);
    else audio.pause();
  };

  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    const playlistPlayButton = target.closest<HTMLElement>('[data-playlist-play]');
    if (playlistPlayButton?.dataset.playlistPlay) {
      const plId = playlistPlayButton.dataset.playlistPlay;
      const playlist = playlistById.get(plId);
      if (playlist) {
        if (currentPlaylist?.id === plId) {
          togglePlayback();
          return;
        }
        currentPlaylist = playlist;
        if (playlist.tracks[0]) selectTrack(playlist.tracks[0]);
      }
      return;
    }
    const trackButton = target.closest<HTMLElement>('[data-track-id]');
    if (trackButton) {
      const trackId = trackButton.dataset.trackId ?? '';
      const nextTrack = trackById.get(trackId);
      const parentPlaylist = trackButton.closest<HTMLElement>('[data-playlist-view]');
      const playlistId = parentPlaylist?.dataset.playlistViewId || parentPlaylist?.dataset.playlistId;
      if (playlistId) {
        const pl = playlistById.get(playlistId);
        if (pl) currentPlaylist = pl;
      }
      if (nextTrack) {
        selectTrack(nextTrack, true);
      }
      return;
    }
    const playlistButton = target.closest<HTMLElement>('button[data-playlist-id], [data-playlist-id]:not([data-playlist-view])');
    if (playlistButton?.dataset.playlistId) {
      showPlaylist(playlistButton.dataset.playlistId, true);
      return;
    }
    if (target.closest('[data-open-lyrics]')) {
      if (lyricsView && !lyricsView.classList.contains('hidden')) {
        showHome(true);
      } else {
        openLyrics(true);
      }
      return;
    }
    if (target.closest('[data-player-cover], [data-player-title]')) {
      openLyrics(true);
      return;
    }
    if (target.closest('[data-play-toggle]')) return togglePlayback();
    if (target.closest('[data-focus-search]')) {
      showSearch(true);
      searchInput?.focus();
      return;
    }
    const lyricButton = target.closest<HTMLButtonElement>('[data-lyric-time]');
    if (lyricButton && audio) {
      audio.currentTime = Number(lyricButton.dataset.lyricTime);
      if (audio.paused) audio.play().catch(() => undefined);
      return;
    }

    const shareButton = target.closest<HTMLButtonElement>('[data-share-button]');
    if (shareButton) {
      void handleShare(shareButton);
      return;
    }

    const likeButton = target.closest<HTMLButtonElement>('[data-like-button]');
    if (likeButton) {
      if (!likeRequestPending) void requestLikeState('POST');
      return;
    }
  });

  all<HTMLButtonElement>('[data-player-next], [data-player-previous]').forEach((button) => {
    button.addEventListener('click', () => {
      const queue = currentPlaylist ? currentPlaylist.tracks : tracks;
      const index = queue.findIndex((track) => track.id === currentTrack.id);
      const offset = button.hasAttribute('data-player-next') ? 1 : -1;
      const nextIndex = index === -1 ? 0 : (index + offset + queue.length) % queue.length;
      selectTrack(queue[nextIndex]);
    });
  });

  all<HTMLInputElement>('[data-seek]').forEach((input) => {
    const handleStart = () => {
      isSeeking = true;
    };
    const handleInput = () => {
      setRangeFill(input);
      setText('[data-elapsed]', formatTime(Number(input.value)));
    };
    const handleEnd = () => {
      if (isSeeking) {
        if (audio) audio.currentTime = Number(input.value);
        isSeeking = false;
        updateProgress();
      }
    };

    input.addEventListener('pointerdown', handleStart);
    input.addEventListener('mousedown', handleStart);
    input.addEventListener('touchstart', handleStart, { passive: true });

    input.addEventListener('input', handleInput);

    input.addEventListener('change', handleEnd);
    input.addEventListener('pointerup', handleEnd);
    input.addEventListener('mouseup', handleEnd);
    input.addEventListener('touchend', handleEnd);
  });
  all<HTMLInputElement>('[data-volume]').forEach((input) => input.addEventListener('input', () => {
    setRangeFill(input);
    if (audio) audio.volume = Number(input.value) / 100;
  }));

  const updateClearButton = () => {
    if (!searchClear || !searchInput) return;
    const hasValue = Boolean(searchInput.value.trim());
    searchClear.classList.toggle('hidden', !hasValue);
    searchClear.classList.toggle('grid', hasValue);
  };

  searchInput?.addEventListener('input', () => {
    updateClearButton();
    renderSearchResults(searchInput.value);
    showSearch(false);
  });
  searchInput?.addEventListener('focus', () => {
    if (homeView && !homeView.classList.contains('hidden')) {
      showSearch(true);
    }
  });
  searchClear?.addEventListener('click', (event) => {
    event.preventDefault();
    if (searchInput) {
      searchInput.value = '';
      updateClearButton();
      renderSearchResults('');
      searchInput.focus();
    }
  });
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const firstResult = searchResults?.querySelector<HTMLElement>('[data-track-id]');
    const track = trackById.get(firstResult?.dataset.trackId ?? '');
    if (track) selectTrack(track, true);
  });

  all<HTMLButtonElement>('[data-history-back]').forEach((button) => button.addEventListener('click', () => window.history.back()));
  all<HTMLButtonElement>('[data-history-forward]').forEach((button) => button.addEventListener('click', () => window.history.forward()));

  window.addEventListener('popstate', (event) => {
    const state = event.state as ViewState | null;
    const hash = window.location.hash;
    if (hash === '#lyrics' || state?.view === 'lyrics') return openLyrics();
    if (hash.startsWith('#playlist=') || (state?.view === 'playlist' && state.playlistId)) {
      const id = state?.playlistId || hash.replace('#playlist=', '');
      return showPlaylist(id);
    }
    if (hash === '#search' || state?.view === 'search') return showSearch();
    return showHome();
  });

  if (audio) {
    audio.volume = 0.66;
    all<HTMLInputElement>('[data-volume]').forEach((input) => setRangeFill(input));
    audio.addEventListener('play', () => {
      isPlaying = true;
      renderPlaybackState();
      syncVideo();
      startProgressLoop();
    });
    audio.addEventListener('pause', () => {
      isPlaying = false;
      renderPlaybackState();
      syncVideo();
      stopProgressLoop();
      updateProgress();
    });
    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('timeupdate', () => {
      if (!isPlaying) updateProgress();
      syncVideo();
      renderLyrics();
    });
    audio.addEventListener('ended', () => {
      const queue = currentPlaylist ? currentPlaylist.tracks : tracks;
      const index = queue.findIndex((track) => track.id === currentTrack.id);
      if (index !== -1 && index + 1 < queue.length) {
        selectTrack(queue[index + 1]);
      } else {
        isPlaying = false;
        renderPlaybackState();
        stopProgressLoop();
        updateProgress();
      }
    });
  }

  const hour = new Date().getHours();
  setText('[data-greeting]', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  renderVideo(currentTrack);
  renderPlaybackState();
  void requestLikeState('GET');
  void loadLyrics(currentTrack);
  const initialHash = window.location.hash;
  if (initialHash === '#lyrics') {
    openLyrics(false);
  } else if (initialHash.startsWith('#playlist=')) {
    showPlaylist(initialHash.replace('#playlist=', ''), false);
  } else if (initialHash === '#search') {
    showSearch(false);
  } else {
    window.history.replaceState({ view: 'home' } satisfies ViewState, '', window.location.pathname + window.location.hash);
  }
}
