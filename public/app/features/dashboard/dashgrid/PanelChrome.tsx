// Libraries
import React, { PureComponent } from 'react';
import classNames from 'classnames';
import { Unsubscribable } from 'rxjs';
// Components
import { PanelHeader } from './PanelHeader/PanelHeader';
import { ErrorBoundary, PanelData, PanelPlugin } from '@grafana/ui';
// Utils & Services
import { getTimeSrv, TimeSrv } from '../services/TimeSrv';
import { applyPanelTimeOverrides } from 'app/features/dashboard/utils/panel';
import { profiler } from 'app/core/profiler';
import { getProcessedDataFrames } from '../state/runRequest';
import templateSrv from 'app/features/templating/template_srv';
import config from 'app/core/config';
// Types
import { DashboardModel, PanelModel } from '../state';
import { LoadingState, ScopedVars, AbsoluteTimeRange, DefaultTimeRange, toUtc, toDataFrameDTO } from '@grafana/data';
import { PanelEvents } from '@grafana/ui';
import { PANEL_BORDER } from 'app/core/constants';

const DEFAULT_PLUGIN_ERROR = 'Error in plugin';

export interface Props {
  panel: PanelModel;
  dashboard: DashboardModel;
  plugin: PanelPlugin;
  isFullscreen: boolean;
  isInView: boolean;
  width: number;
  height: number;
}

export interface State {
  isFirstLoad: boolean;
  renderCounter: number;
  errorMessage: string | null;
  refreshWhenInView: boolean;

  // Current state of all events
  data: PanelData;
}

export class PanelChrome extends PureComponent<Props, State> {
  timeSrv: TimeSrv = getTimeSrv();
  querySubscription: Unsubscribable;

  constructor(props: Props) {
    super(props);
    this.state = {
      isFirstLoad: true,
      renderCounter: 0,
      errorMessage: null,
      refreshWhenInView: false,
      data: {
        state: LoadingState.NotStarted,
        series: [],
        timeRange: DefaultTimeRange,
      },
    };
  }

  componentDidMount() {
    const { panel, dashboard } = this.props;
    panel.events.on(PanelEvents.refresh, this.onRefresh);
    panel.events.on(PanelEvents.render, this.onRender);
    dashboard.panelInitialized(this.props.panel);

    // Move snapshot data into the query response
    if (this.hasPanelSnapshot) {
      this.setState({
        data: {
          ...this.state.data,
          state: LoadingState.Done,
          series: getProcessedDataFrames(panel.snapshotData),
        },
        isFirstLoad: false,
      });
    } else if (!this.wantsQueryExecution) {
      this.setState({ isFirstLoad: false });
    }
  }

  componentWillUnmount() {
    this.props.panel.events.off(PanelEvents.refresh, this.onRefresh);
    this.props.panel.events.off(PanelEvents.render, this.onRender);

    if (this.querySubscription) {
      this.querySubscription.unsubscribe();
      this.querySubscription = null;
    }
  }

  componentDidUpdate(prevProps: Props) {
    const { isInView } = this.props;

    // View state has changed
    if (isInView !== prevProps.isInView) {
      if (isInView) {
        // Check if we need a delayed refresh
        if (this.state.refreshWhenInView) {
          this.onRefresh();
        }
      } else if (this.querySubscription) {
        this.querySubscription.unsubscribe();
        this.querySubscription = null;
      }
    }
  }

  // Updates the response with information from the stream
  // The next is outside a react synthetic event so setState is not batched
  // So in this context we can only do a single call to setState
  panelDataObserver = {
    next: (data: PanelData) => {
      if (!this.props.isInView) {
        // Ignore events when not visible.
        // The call will be repeated when the panel comes into view
        return;
      }

      let { isFirstLoad } = this.state;
      let errorMessage: string | null = null;

      switch (data.state) {
        case LoadingState.Loading:
          // Skip updating state data if it is already in loading state
          // This is to avoid rendering partial loading responses
          if (this.state.data.state === LoadingState.Loading) {
            return;
          }
          break;
        case LoadingState.Error:
          const { error } = data;
          if (error) {
            if (errorMessage !== error.message) {
              errorMessage = error.message;
            }
          }
          break;
        case LoadingState.Done:
          // If we are doing a snapshot save data in panel model
          if (this.props.dashboard.snapshot) {
            this.props.panel.snapshotData = data.series.map(frame => toDataFrameDTO(frame));
          }
          if (isFirstLoad) {
            isFirstLoad = false;
          }
          break;
      }

      this.setState({ isFirstLoad, errorMessage, data });
    },
  };

  onRefresh = () => {
    const { panel, isInView, width } = this.props;

    if (!isInView) {
      console.log('Refresh when panel is visible', panel.id);
      this.setState({ refreshWhenInView: true });
      return;
    }

    const timeData = applyPanelTimeOverrides(panel, this.timeSrv.timeRange());

    // Issue Query
    if (this.wantsQueryExecution) {
      if (width < 0) {
        console.log('Refresh skippted, no width yet... wait till we know');
        return;
      }

      const queryRunner = panel.getQueryRunner();

      if (!this.querySubscription) {
        this.querySubscription = queryRunner.getData().subscribe(this.panelDataObserver);
      }

      queryRunner.run({
        datasource: panel.datasource,
        queries: panel.targets,
        panelId: panel.id,
        dashboardId: this.props.dashboard.id,
        timezone: this.props.dashboard.getTimezone(),
        timeRange: timeData.timeRange,
        timeInfo: timeData.timeInfo,
        widthPixels: width,
        maxDataPoints: panel.maxDataPoints,
        minInterval: panel.interval,
        scopedVars: panel.scopedVars,
        cacheTimeout: panel.cacheTimeout,
        transformations: panel.transformations,
      });
    }
  };

  onRender = () => {
    const stateUpdate = { renderCounter: this.state.renderCounter + 1 };

    this.setState(stateUpdate);
  };

  onOptionsChange = (options: any) => {
    this.props.panel.updateOptions(options);
  };

  replaceVariables = (value: string, extraVars?: ScopedVars, format?: string) => {
    let vars = this.props.panel.scopedVars;
    if (extraVars) {
      vars = vars ? { ...vars, ...extraVars } : extraVars;
    }
    return templateSrv.replace(value, vars, format);
  };

  onPanelError = (message: string) => {
    if (this.state.errorMessage !== message) {
      this.setState({ errorMessage: message });
    }
  };

  get hasPanelSnapshot() {
    const { panel } = this.props;
    return panel.snapshotData && panel.snapshotData.length;
  }

  get wantsQueryExecution() {
    return !(this.props.plugin.meta.skipDataQuery || this.hasPanelSnapshot);
  }

  onChangeTimeRange = (timeRange: AbsoluteTimeRange) => {
    this.timeSrv.setTime({
      from: toUtc(timeRange.from),
      to: toUtc(timeRange.to),
    });
  };

  renderPanel(width: number, height: number): JSX.Element {
    const { panel, plugin } = this.props;
    const { renderCounter, data, isFirstLoad } = this.state;
    const { theme } = config;

    // This is only done to increase a counter that is used by backend
    // image rendering (phantomjs/headless chrome) to know when to capture image
    const loading = data.state;
    if (loading === LoadingState.Done) {
      profiler.renderingCompleted();
    }

    // do not render component until we have first data
    if (isFirstLoad && (loading === LoadingState.Loading || loading === LoadingState.NotStarted)) {
      return this.renderLoadingState();
    }

    const PanelComponent = plugin.panel;
    const timeRange = data.timeRange || this.timeSrv.timeRange();

    const headerHeight = this.hasOverlayHeader() ? 0 : theme.panelHeaderHeight;
    const chromePadding = plugin.hasFullChromeControl ? 0 : theme.panelPadding;
    const panelWidth = width - chromePadding * 2 - PANEL_BORDER;
    const innerPanelHeight = height - headerHeight - chromePadding * 2;

    const panelContentClassNames = classNames({
      'panel-content': true,
      'panel-content--no-padding': plugin.hasFullChromeControl,
    });

    return (
      <>
        {loading === LoadingState.Loading && this.renderLoadingState()}
        <div className={panelContentClassNames}>
          <PanelComponent
            id={panel.id}
            data={data}
            timeRange={timeRange}
            timeZone={this.props.dashboard.getTimezone()}
            options={panel.getOptions()}
            transparent={panel.transparent}
            width={panelWidth}
            height={innerPanelHeight}
            renderCounter={renderCounter}
            replaceVariables={this.replaceVariables}
            onOptionsChange={this.onOptionsChange}
            onChangeTimeRange={this.onChangeTimeRange}
          />
        </div>
      </>
    );
  }

  private renderLoadingState(): JSX.Element {
    return (
      <div className="panel-loading">
        <i className="fa fa-spinner fa-spin" />
      </div>
    );
  }

  hasOverlayHeader() {
    const { panel, plugin } = this.props;
    const { errorMessage, data } = this.state;

    // always show normal header if we have an error message
    if (errorMessage) {
      return false;
    }

    // always show normal header if we have time override
    if (data.request && data.request.timeInfo) {
      return false;
    }

    return !panel.hasTitle() || plugin.hasFullChromeControl;
  }

  render() {
    const { dashboard, panel, isFullscreen, width, height, plugin } = this.props;
    const { errorMessage, data } = this.state;
    const { transparent } = panel;

    const containerClassNames = classNames({
      'panel-container': true,
      'panel-container--absolute': true,
      'panel-container--overlay-header': this.hasOverlayHeader(),
      'panel-transparent': transparent || plugin.hasFullChromeControl,
    });

    return (
      <div className={containerClassNames}>
        <PanelHeader
          panel={panel}
          dashboard={dashboard}
          timeInfo={data.request ? data.request.timeInfo : null}
          title={panel.title}
          description={panel.description}
          scopedVars={panel.scopedVars}
          links={panel.links}
          error={errorMessage}
          isFullscreen={isFullscreen}
        />
        <ErrorBoundary>
          {({ error, errorInfo }) => {
            if (errorInfo) {
              this.onPanelError(error.message || DEFAULT_PLUGIN_ERROR);
              return null;
            }
            return this.renderPanel(width, height);
          }}
        </ErrorBoundary>
      </div>
    );
  }
}
