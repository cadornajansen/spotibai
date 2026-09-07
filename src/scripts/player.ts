import { nowPlaying, playlists, tracks } from '../data/spotify';
import type { Track } from '../types/library';

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

  let currentTrack = nowPlaying;
  let isPlaying = false;
  let lyricLines: LyricLine[] = [];
  let activeLyricIndex = -1;
  let likeRequestId = 0;
  let likeRequestPending = false;

  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const playlistById = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const all = <T extends Element>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
  const setText = (selector: string, value: string) => all<HTMLElement>(selector).forEach((element) => { element.textContent = value; });
  const setImage = (selector: string, track: Track) => all<HTMLImageElement>(selector).forEach((image) => { image.src = track.cover; image.alt = `${track.title} cover`; });
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
    all<SVGElement>('[data-like-icon]').forEach((icon) => icon.classList.toggle('fill-[#1ed760]', state.liked));
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
      const response = await fetch(`/api/likes/${encodeURIComponent(track.id)}`, { method });
      if (!response.ok) throw new Error('Like request failed');
      const state = await response.json() as LikeState;
      if (requestId !== likeRequestId || track.id !== currentTrack.id) return;
      renderLikeState(state);
      if (state.configured === false) {
        setLikeStatus('Likes are unavailable until Redis is configured.');
        return;
      }
      setLikeStatus(`${state.count} ${state.count === 1 ? 'like' : 'likes'}; ${state.liked ? 'liked' : 'not liked'}`);
    } catch {
      if (requestId !== likeRequestId || track.id !== currentTrack.id) return;
      renderLikeState({ count: 0, liked: false });
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

  const showHome = (shouldStore = false) => {
    hideViews();
    homeView?.classList.remove('hidden');
    main?.scrollTo({ top: 0 });
    if (shouldStore) storeView({ view: 'home' });
  };

  const showPlaylist = (playlistId: string, shouldStore = false) => {
    const playlistView = playlistViews.find((view) => view.dataset.playlistId === playlistId);
    if (!playlistView) return;
    hideViews();
    playlistView.classList.remove('hidden');
    main?.scrollTo({ top: 0 });
    if (shouldStore) storeView({ view: 'playlist', playlistId });
  };

  const showSearch = (shouldStore = false) => {
    hideViews();
    searchView?.classList.remove('hidden');
    main?.scrollTo({ top: 0 });
    if (shouldStore) storeView({ view: 'search' });
  };

  const renderPlaybackState = () => {
    all<HTMLElement>('[data-play-icon]').forEach((icon) => icon.classList.toggle('hidden', isPlaying));
    all<HTMLElement>('[data-pause-icon]').forEach((icon) => icon.classList.toggle('hidden', !isPlaying));
    all<HTMLButtonElement>('[data-play-toggle]').forEach((button) => button.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play'));
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
      line.element.classList.toggle('text-white', index === currentIndex);
      line.element.classList.toggle('text-[#c9aa9a]', index !== currentIndex);
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

  const loadLyrics = async (track: Track) => {
    lyricLines = [];
    activeLyricIndex = -1;
    if (!lyricsContainer || !lyricsEmpty) return;
    lyricsContainer.replaceChildren();
    lyricsEmpty.classList.add('hidden');

    try {
      const response = await fetch(track.lyricsSrc);
      if (!response.ok) throw new Error('Lyrics file not found');
      const lines = parseLrc(await response.text());
      if (lines.length === 0) throw new Error('Lyrics file has no timed lines');
      lyricLines = lines.map((line) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.dataset.lyricTime = String(line.time);
        element.className = 'block w-full text-left text-2xl font-bold leading-tight text-[#c9aa9a] transition-colors hover:text-white sm:text-5xl';
        element.textContent = line.text;
        lyricsContainer.append(element);
        return { time: line.time, element };
      });
      renderLyrics();
    } catch {
      lyricsEmpty.classList.remove('hidden');
    }
  };

  const openLyrics = (shouldStore = false) => {
    hideViews();
    lyricsView?.classList.remove('hidden');
    main?.scrollTo({ top: 0 });
    void loadLyrics(currentTrack);
    if (shouldStore) storeView({ view: 'lyrics' });
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
    all<HTMLInputElement>('[data-seek]').forEach((input) => {
      input.max = String(duration || 1);
      input.value = String(audio.currentTime);
      setRangeFill(input);
    });
    setText('[data-elapsed]', formatTime(audio.currentTime));
    setText('[data-player-duration]', duration ? formatTime(duration) : currentTrack.duration);
  };

  const selectTrack = (track: Track, shouldOpenLyrics = false) => {
    currentTrack = track;
    setText('[data-player-title], [data-now-title], [data-lyrics-title]', track.title);
    setText('[data-player-artist], [data-now-artist], [data-lyrics-artist]', track.artist);
    setImage('[data-player-cover], [data-now-cover], [data-lyrics-cover]', track);
    renderVideo(track);
    renderLikeState({ count: 0, liked: false }, true);
    void requestLikeState('GET');

    if (audio) {
      audio.pause();
      audio.src = track.audioSrc;
      audio.load();
      updateProgress();
      audio.play().then(() => { isPlaying = true; renderPlaybackState(); }).catch(() => { isPlaying = false; renderPlaybackState(); });
    }
    if (shouldOpenLyrics) openLyrics(true);
  };

  const renderSearchResults = (query: string) => {
    if (!searchResults || !searchSummary) return;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = normalizedQuery ? tracks.filter((track) => `${track.title} ${track.artist}`.toLocaleLowerCase().includes(normalizedQuery)) : [];
    searchResults.replaceChildren();
    searchSummary.textContent = normalizedQuery
      ? `${matches.length} ${matches.length === 1 ? 'result' : 'results'} for “${query.trim()}”`
      : 'Start typing to search your local music.';
    matches.forEach((track) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.dataset.trackId = track.id;
      result.className = 'group flex w-full items-center gap-3.5 rounded-lg px-3 py-2.5 text-left transition-all duration-150 hover:bg-white/10 active:bg-white/15';
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
    const playlistButton = target.closest<HTMLElement>('[data-playlist-id]');
    if (playlistButton?.dataset.playlistId) {
      showPlaylist(playlistButton.dataset.playlistId, true);
      return;
    }
    const playlistPlayButton = target.closest<HTMLElement>('[data-playlist-play]');
    if (playlistPlayButton?.dataset.playlistPlay) {
      const playlist = playlistById.get(playlistPlayButton.dataset.playlistPlay);
      if (playlist?.tracks[0]) selectTrack(playlist.tracks[0]);
      return;
    }
    const trackButton = target.closest<HTMLElement>('[data-track-id]');
    if (trackButton) {
      const nextTrack = trackById.get(trackButton.dataset.trackId ?? '');
      if (nextTrack) selectTrack(nextTrack, true);
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

    const likeButton = target.closest<HTMLButtonElement>('[data-like-button]');
    if (likeButton) {
      if (!likeRequestPending) void requestLikeState('POST');
      return;
    }
  });

  all<HTMLButtonElement>('[data-player-next], [data-player-previous]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = tracks.findIndex((track) => track.id === currentTrack.id);
      const offset = button.hasAttribute('data-player-next') ? 1 : -1;
      selectTrack(tracks[(index + offset + tracks.length) % tracks.length]);
    });
  });

  all<HTMLInputElement>('[data-seek]').forEach((input) => input.addEventListener('input', () => {
    setRangeFill(input);
    if (audio) audio.currentTime = Number(input.value);
  }));
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
    if (!state || state.view === 'home') return showHome();
    if (state.view === 'search') return showSearch();
    if (state.view === 'playlist' && state.playlistId) return showPlaylist(state.playlistId);
    if (state.view === 'lyrics') openLyrics();
  });

  if (audio) {
    audio.volume = 0.66;
    all<HTMLInputElement>('[data-volume]').forEach((input) => setRangeFill(input));
    audio.addEventListener('play', () => { isPlaying = true; renderPlaybackState(); syncVideo(); });
    audio.addEventListener('pause', () => { isPlaying = false; renderPlaybackState(); syncVideo(); });
    audio.addEventListener('loadedmetadata', updateProgress);
    audio.addEventListener('timeupdate', () => { updateProgress(); syncVideo(); renderLyrics(); });
    audio.addEventListener('ended', () => { isPlaying = false; renderPlaybackState(); });
  }

  const hour = new Date().getHours();
  setText('[data-greeting]', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  renderVideo(currentTrack);
  renderPlaybackState();
  void requestLikeState('GET');
  window.history.replaceState({ view: 'home' } satisfies ViewState, '', window.location.pathname);
}
