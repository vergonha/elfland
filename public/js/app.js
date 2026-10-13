/**
 * NodeCast TV Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'home';
        this.pages = {};
        this.currentUser = null;

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();

        // Initialize page controllers
        this.pages.home = new HomePage(this);
        this.pages.live = new LivePage(this);
        this.pages.guide = new GuidePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.watch = new WatchPage(this);

        this.init();
    }

    async init() {
        // Check authentication first
        if (!await this.checkAuth()) return;

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) {
            mobileMenuToggle.addEventListener('click', () => {
                mobileMenuToggle.classList.toggle('active');
                navbarMenu.classList.toggle('active');
            });

            // Close menu when a nav link is clicked
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                });
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.navbar')) {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                }
            });
        }

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                if (e.target.closest('.channel-item')) {
                    // Small delay to let the channel selection happen
                    setTimeout(() => {
                        channelSidebar.classList.remove('active');
                        channelOverlay.classList.remove('active');
                    }, 300);
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
        const homeLayout = document.querySelector('.home-layout');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');
            homeLayout?.classList.toggle('sidebar-collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
            homeLayout?.classList.add('sidebar-collapsed');
        }

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        document.querySelector(".navbar-brand").addEventListener('click', (e) => {
            e.preventDefault();
            this.navigateTo('home');    
        })

        // Now Playing indicator
        const nowPlayingBtn = document.getElementById('now-playing-indicator');
        if (nowPlayingBtn) {
            nowPlayingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo('watch');
            });
        }

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Handle browser back/forward buttons
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || 'home';
            this.navigateTo(page, false); // false = don't add to history
        });

        // Initialize home page first (it's needed for channel list)
        await this.pages.home.init();

        // Preload EPG data in background (non-blocking)
        // This ensures EPG info is available on Live TV page without visiting Guide first
        this.epgGuide.loadEpg().catch(err => {
            console.warn('Background EPG load failed:', err.message);
        });

        // Navigate to the page from URL hash, or default to home
        const hash = window.location.hash.slice(1); // Remove #
        const initialPage = hash && this.pages[hash] ? hash : 'home';
        this.navigateTo(initialPage, true); // true = replace history (don't add)

        console.log('NodeCast TV initialized');
    }

    async checkAuth() {
        const token = localStorage.getItem('authToken');

        try {
            if (token) {
                const migrated = await fetch('/api/auth/session', { method: 'POST',
                    headers: { Authorization: `Bearer ${token}` } });
                localStorage.removeItem('authToken');
                if (!migrated.ok) throw new Error('Please sign in again');
            }
            const response = await fetch('/api/auth/me', { credentials: 'same-origin' });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();

            // Hide settings for viewers
            if (this.currentUser.role === 'viewer') {
                const settingsLink = document.querySelector('.nav-link[data-page="settings"]');
                if (settingsLink) {
                    settingsLink.style.display = 'none';
                }
            }

            // Add logout button to navbar
            this.addLogoutButton();
            return true;

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
            return false;
        }
    }

    addLogoutButton() {
        const navbar = document.querySelector('.navbar-menu');
        if (!navbar || document.getElementById('logout-btn')) return;

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'nav-link';
        logoutLink.id = 'logout-btn';
        logoutLink.innerHTML = `
            <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M8 11h12v2H8zm8-2h2v2h-2z"/>
  <path d="M14 7h2v10h-2zm2 6h2v2h-2zM6 2h12v2H6zm0 18h12v2H6zM4 4h2v16H4zm14 0h2v3h-2zm0 13h2v3h-2z"/></svg></span>
            <span>Logout</span>
        `;

        logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();

            this.player.stop();
            this.pages.watch.stop();
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });

            localStorage.removeItem('authToken');
            window.location.replace('/login.html');
        });

        navbar.appendChild(logoutLink);
    }

    navigateTo(pageName, replaceHistory = false) {
        // Don't navigate if already on this page
        if (this.currentPage === pageName && !replaceHistory) {
            return;
        }

        // Update browser history
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            history.replaceState({ page: pageName }, '', `#${pageName}`);
        } else {
            // Add new history entry
            history.pushState({ page: pageName }, '', `#${pageName}`);
        }

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.currentPage = pageName;

        if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();

    // Fetch and display version badge
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const badge = document.getElementById('version-badge');
            if (badge && data.version) badge.textContent = `nodecast v${data.version}`;
        })
        .catch(() => { });
});
