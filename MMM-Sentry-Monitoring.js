Module.register("MMM-Sentry-Monitoring", {

  defaults: {
    sentryAuthToken: "",
    sentryOrgSlug: "",
    sentryProjectSlug: "",
    updateInterval: 30000,  // 30 seconds
    displayCount: 5,
    timeRange: "24h",
    sortBy: "freq",  // freq, last_seen, first_seen
    minEvents: 1
  },

  /**
   * Apply the default styles.
   */
  getStyles() {
    return ["MMM-Sentry-Monitoring.css"];
  },

  /**
   * Module initialization
   */
  start() {
    Log.info("Starting module: " + this.name);

    this.sentryData = null;
    this.isLoading = true;
    this.error = null;
    this.firstLoad = true;
    this.newIssueIds = new Set();

    // Validate configuration
    if (!this.validateConfig()) {
      this.error = "Missing required configuration: sentryAuthToken, sentryOrgSlug, or sentryProjectSlug";
      this.isLoading = false;
      return;
    }

    // Send configuration to node helper
    this.sendSocketNotification("SENTRY_CONFIG", this.config);

    // Schedule periodic updates
    setInterval(() => {
      this.sendSocketNotification("SENTRY_FETCH", {});
    }, this.config.updateInterval);
  },

  /**
   * Validate required configuration
   */
  validateConfig() {
    return this.config.sentryAuthToken &&
      this.config.sentryOrgSlug &&
      this.config.sentryProjectSlug;
  },

  /**
   * Handle socket notifications from node helper
   */
  socketNotificationReceived(notification, payload) {
    if (notification === "SENTRY_UPDATE") {
      this.isLoading = false;

      // Track new issues for pulse animation
      if (this.sentryData && this.sentryData.issues) {
        const oldIds = new Set(this.sentryData.issues.map(i => i.id));
        const newIds = payload.issues.map(i => i.id).filter(id => !oldIds.has(id));

        // Add new issues to set for pulse animation
        newIds.forEach(id => this.newIssueIds.add(id));

        // Remove old pulse animations after 10 seconds
        setTimeout(() => {
          newIds.forEach(id => this.newIssueIds.delete(id));
          this.updateDom(300);
        }, 10000);
      }

      this.sentryData = payload;
      this.error = payload.error || null;

      if (this.firstLoad) {
        this.updateDom(0);
        this.firstLoad = false;
      } else {
        this.updateDom(300);
      }
    } else if (notification === "SENTRY_ERROR") {
      this.isLoading = false;
      this.error = payload.error;
      this.updateDom(300);
    }
  },

  /**
   * Render the module DOM
   */
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "sentry-monitor";

    // Show configuration error
    if (!this.validateConfig()) {
      wrapper.innerHTML = `
        <div class="sentry-error">
          <div class="error-icon">⚙️</div>
          <div class="error-title">Configure MMM-Sentry-Monitoring</div>
          <div class="error-message">
            Please set sentryAuthToken, sentryOrgSlug, and sentryProjectSlug in your config.
          </div>
        </div>
      `;
      return wrapper;
    }

    // Show loading state
    if (this.isLoading) {
      wrapper.innerHTML = `
        <div class="sentry-loading">
          <div class="loading-icon">⏳</div>
          <div class="loading-text">Fetching errors from Sentry...</div>
        </div>
      `;
      return wrapper;
    }

    // Show error state
    if (this.error && (!this.sentryData || !this.sentryData.issues)) {
      wrapper.innerHTML = `
        <div class="sentry-error">
          <div class="error-icon">❌</div>
          <div class="error-title">Failed to fetch Sentry data</div>
          <div class="error-message">${this.error}</div>
          <div class="error-hint">Check your auth token and project configuration.</div>
        </div>
      `;
      return wrapper;
    }

    // Render header
    const header = this.renderHeader();
    wrapper.appendChild(header);

    // Render issues
    if (this.sentryData && this.sentryData.issues && this.sentryData.issues.length > 0) {
      const issuesList = this.renderIssues();
      wrapper.appendChild(issuesList);
    } else {
      const noIssues = document.createElement("div");
      noIssues.className = "sentry-no-issues";
      noIssues.innerHTML = `
        <div class="success-icon">✅</div>
        <div class="success-text">No unresolved issues found!</div>
      `;
      wrapper.appendChild(noIssues);
    }

    // Show error banner if there's a cached data error
    if (this.error && this.sentryData) {
      const errorBanner = document.createElement("div");
      errorBanner.className = "sentry-error-banner";
      errorBanner.innerHTML = `⚠️ ${this.error}`;
      wrapper.appendChild(errorBanner);
    }

    return wrapper;
  },

  /**
   * Render header section
   */
  renderHeader() {
    const header = document.createElement("div");
    header.className = "sentry-header";

    const title = document.createElement("div");
    title.className = "header-title";
    title.textContent = "Sentry Error Monitor";

    const meta = document.createElement("div");
    meta.className = "header-meta";

    if (this.sentryData) {
      const timeAgo = this.getTimeAgo(this.sentryData.lastUpdated);
      meta.innerHTML = `
        Last updated: ${timeAgo} | 
        Sample size: last ${this.sentryData.totalIssues} unresolved issues
      `;
    }

    header.appendChild(title);
    header.appendChild(meta);

    return header;
  },

  /**
   * Render issues list
   */
  renderIssues() {
    const container = document.createElement("div");
    container.className = "sentry-issues";

    this.sentryData.issues.forEach((issue, index) => {
      const card = this.renderIssueCard(issue, index + 1);
      container.appendChild(card);
    });

    return container;
  },

  /**
   * Render individual issue card
   */
  renderIssueCard(issue, rank) {
    const card = document.createElement("div");
    card.className = `error-card error-level-${issue.level}`;

    // Add new issue pulse animation
    if (this.newIssueIds.has(issue.id)) {
      card.classList.add("new-issue");
    }

    // Add title attribute for full error message on hover
    card.title = issue.title;

    // Rank
    const rankEl = document.createElement("div");
    rankEl.className = "error-rank";
    rankEl.textContent = `${rank}.`;

    // Main content
    const main = document.createElement("div");
    main.className = "error-main";

    const title = document.createElement("div");
    title.className = "error-title";
    title.textContent = issue.shortTitle;

    const meta = document.createElement("div");
    meta.className = "error-meta";

    meta.innerHTML = `
      <span class="error-project">${issue.project} | ${issue.count} events</span>
    `;

    main.appendChild(title);
    main.appendChild(meta);

    // Detail section
    const detail = document.createElement("div");
    detail.className = "error-detail";

    const seen = document.createElement("div");
    seen.className = "error-seen";
    seen.textContent = `Last: ${issue.timeAgo}`;

    const percent = document.createElement("div");
    percent.className = "error-percent";
    percent.innerHTML = `
      <span class="percent-text">${issue.percentage}% of all errors</span>
      <div class="percent-bar">
        <div class="percent-fill" style="width: ${issue.percentage}%"></div>
      </div>
    `;

    detail.appendChild(seen);
    detail.appendChild(percent);

    // Assemble card
    card.appendChild(rankEl);
    card.appendChild(main);
    card.appendChild(detail);

    return card;
  },

  /**
   * Capitalize first letter
   */
  capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  },

  /**
   * Format time ago from ISO string
   */
  getTimeAgo(isoString) {
    if (!isoString) return "unknown";

    const now = Date.now();
    const past = new Date(isoString).getTime();
    const seconds = Math.floor((now - past) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
});
