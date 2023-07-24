/* @odoo-module */

import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { sprintf } from "@web/core/utils/strings";
import { DataPoint } from "./datapoint";
import { Record } from "./record";

const DEFAULT_HANDLE_FIELD = "sequence";

export class DynamicList extends DataPoint {
    /**
     * @param {import("./relational_model").Config} config
     */
    setup(config) {
        super.setup(...arguments);
        this.handleField = Object.keys(this.activeFields).find(
            (fieldName) => this.activeFields[fieldName].isHandle
        );
        if (!this.handleField && DEFAULT_HANDLE_FIELD in this.fields) {
            this.handleField = DEFAULT_HANDLE_FIELD;
        }
        this.isDomainSelected = false;
        this.evalContext = this.context;
    }

    // -------------------------------------------------------------------------
    // Getters
    // -------------------------------------------------------------------------

    get groupBy() {
        return [];
    }

    get orderBy() {
        return this.config.orderBy;
    }

    get domain() {
        return this.config.domain;
    }

    get editedRecord() {
        return this.records.find((record) => record.isInEdition);
    }

    get limit() {
        return this.config.limit;
    }

    get offset() {
        return this.config.offset;
    }

    get selection() {
        return this.records.filter((record) => record.selected);
    }

    // -------------------------------------------------------------------------
    // Public
    // -------------------------------------------------------------------------

    archive(isSelected) {
        return this.model.mutex.exec(() => this._toggleArchive(isSelected, true));
    }

    canResequence() {
        return !!this.handleField;
    }

    deleteRecords(records = []) {
        return this.model.mutex.exec(() => this._deleteRecords(records));
    }

    async enterEditMode(record) {
        if (this.editedRecord === record) {
            return true;
        }
        const canProceed = await this.leaveEditMode();
        if (canProceed) {
            this.model._updateConfig(record.config, { mode: "edit" }, { noReload: true });
        }
        return canProceed;
    }

    /**
     * @param {boolean} [isSelected]
     * @returns {Promise<number[]>}
     */
    async getResIds(isSelected) {
        let resIds;
        if (isSelected) {
            if (this.isDomainSelected) {
                resIds = await this.model.orm.search(this.resModel, this.domain, {
                    limit: this.model.activeIdsLimit,
                    context: this.context,
                });
            } else {
                resIds = this.selection.map((r) => r.resId);
            }
        } else {
            resIds = this.records.map((r) => r.resId);
        }
        return resIds;
    }

    async leaveEditMode({ discard } = {}) {
        if (this.editedRecord) {
            let canProceed = true;
            if (discard) {
                await this.editedRecord.discard();
                if (this.editedRecord && this.editedRecord.isNew) {
                    this._removeRecords([this.editedRecord.id]);
                }
            } else {
                if (!this.model._urgentSave) {
                    await this.editedRecord.checkValidity();
                    if (!this.editedRecord) {
                        return true;
                    }
                }
                if (this.editedRecord.isNew && !this.editedRecord.dirty) {
                    this._removeRecords([this.editedRecord.id]);
                } else {
                    canProceed = await this.editedRecord.save();
                }
            }

            if (canProceed && this.editedRecord) {
                this.model._updateConfig(
                    this.editedRecord.config,
                    { mode: "readonly" },
                    { noReload: true }
                );
            } else {
                return canProceed;
            }
        }
        return true;
    }

    load(params = {}) {
        const limit = params.limit === undefined ? this.limit : params.limit;
        const offset = params.offset === undefined ? this.offset : params.offset;
        const orderBy = params.orderBy === undefined ? this.orderBy : params.orderBy;
        const domain = params.domain === undefined ? this.domain : params.domain;
        return this.model.mutex.exec(() => this._load(offset, limit, orderBy, domain));
    }

    async multiSave(record) {
        return this.model.mutex.exec(() => this._multiSave(record));
    }

    selectDomain(value) {
        return this.model.mutex.exec(() => {
            this.isDomainSelected = value;
        });
    }

    sortBy(fieldName) {
        return this.model.mutex.exec(() => {
            let orderBy = [...this.orderBy];
            if (orderBy.length && orderBy[0].name === fieldName) {
                orderBy[0] = { name: orderBy[0].name, asc: !orderBy[0].asc };
            } else {
                orderBy = orderBy.filter((o) => o.name !== fieldName);
                orderBy.unshift({
                    name: fieldName,
                    asc: true,
                });
            }
            return this._load(this.offset, this.limit, orderBy, this.domain);
        });
    }

    unarchive(isSelected) {
        return this.model.mutex.exec(() => this._toggleArchive(isSelected, false));
    }

    // -------------------------------------------------------------------------
    // Protected
    // -------------------------------------------------------------------------

    async _deleteRecords(records) {
        let resIds;
        if (records.length) {
            resIds = records.map((r) => r.resId);
        } else {
            resIds = await this.getResIds(true);
            records = this.records.filter((r) => resIds.includes(r.resId));
        }
        const unlinked = await this.model.orm.unlink(this.resModel, resIds, {
            context: this.context,
        });
        if (!unlinked) {
            return false;
        }
        if (
            this.isDomainSelected &&
            resIds.length === this.model.activeIdsLimit &&
            resIds.length < this.count
        ) {
            const msg = sprintf(
                _t(`Only the first %s records have been deleted (out of %s selected)`),
                resIds.length,
                this.count
            );
            this.model.notification.add(msg, { title: _t("Warning") });
        }
        await this._removeRecords(records.map((r) => r.id));
        return unlinked;
    }

    _leaveSampleMode() {
        if (this.model.useSampleModel) {
            this.model.useSampleModel = false;
            return this._load(this.offset, this.limit, this.orderBy, this.domain);
        }
    }

    async _multiSave(record) {
        const changes = record._getChanges();
        if (!Object.keys(changes).length) {
            return;
        }
        const validSelection = this.selection.filter((record) => {
            return Object.keys(changes).every((fieldName) => {
                if (record._isReadonly(fieldName)) {
                    return false;
                } else if (record._isRequired(fieldName) && !changes[fieldName]) {
                    return false;
                }
                return true;
            });
        });
        const canProceed = await this.model.hooks.onWillSaveMulti(record, changes, validSelection);
        if (canProceed === false) {
            return false;
        }
        if (validSelection.length === 0) {
            this.model.dialog.add(AlertDialog, {
                body: _t("No valid record to save"),
                confirm: () => this.leaveEditMode({ discard: true }),
            });
            return false;
        } else {
            const resIds = validSelection.map((r) => r.resId);
            const context = this.context;
            try {
                await this.model.orm.write(this.resModel, resIds, changes, { context });
            } catch (e) {
                record._discard();
                this.model._updateConfig(record.config, { mode: "readonly" }, { noReload: true });
                throw e;
            }
            const records = await this.model._loadRecords({ ...this.config, resIds });
            for (const record of validSelection) {
                const serverValues = records.find((r) => r.id === record.resId);
                record._applyValues(serverValues);
                this.model._updateSimilarRecords(record, serverValues);
            }
            record._discard();
            this.model._updateConfig(record.config, { mode: "readonly" }, { noReload: true });
        }
        this.model.hooks.onSavedMulti(validSelection);
        return true;
    }

    async _resequence(originalList, resModel, movedId, targetId) {
        if (this.resModel === resModel && !this.canResequence()) {
            return originalList;
        }
        const handleField = this.handleField;
        const dataPoints = [...originalList];
        const order = this.orderBy.find((o) => o.name === handleField);
        const asc = !order || order.asc;

        // Find indices
        const fromIndex = dataPoints.findIndex((d) => d.id === movedId);
        let toIndex = 0;
        if (targetId !== null) {
            const targetIndex = dataPoints.findIndex((d) => d.id === targetId);
            toIndex = fromIndex > targetIndex ? targetIndex + 1 : targetIndex;
        }

        const getSequence = (dp) => dp && this._getDPHandleField(dp, handleField);

        // Determine which records/groups need to be modified
        const firstIndex = Math.min(fromIndex, toIndex);
        const lastIndex = Math.max(fromIndex, toIndex) + 1;
        let reorderAll = dataPoints.some(
            (dp) => this._getDPHandleField(dp, handleField) === undefined
        );
        if (!reorderAll) {
            let lastSequence = (asc ? -1 : 1) * Infinity;
            for (let index = 0; index < dataPoints.length; index++) {
                const sequence = getSequence(dataPoints[index]);
                if (
                    ((index < firstIndex || index >= lastIndex) &&
                        ((asc && lastSequence >= sequence) ||
                            (!asc && lastSequence <= sequence))) ||
                    (index >= firstIndex && index < lastIndex && lastSequence === sequence)
                ) {
                    reorderAll = true;
                }
                lastSequence = sequence;
            }
        }

        // Perform the resequence in the list of records/groups
        const [dp] = dataPoints.splice(fromIndex, 1);
        dataPoints.splice(toIndex, 0, dp);

        // Creates the list of records/groups to modify
        let toReorder = dataPoints;
        if (!reorderAll) {
            toReorder = toReorder.slice(firstIndex, lastIndex).filter((r) => r.id !== movedId);
            if (fromIndex < toIndex) {
                toReorder.push(dp);
            } else {
                toReorder.unshift(dp);
            }
        }
        if (!asc) {
            toReorder.reverse();
        }

        const resIds = toReorder.map((d) => this._getDPresId(d)).filter((id) => id && !isNaN(id));
        const sequences = toReorder.map(getSequence);
        const offset = sequences.length && Math.min(...sequences);

        // Try to write new sequences on the affected records/groups
        const params = {
            model: resModel,
            ids: resIds,
            context: this.context,
            field: handleField,
        };
        if (offset) {
            params.offset = offset;
        }
        const wasResequenced = await this.model.rpc("/web/dataset/resequence", params);
        if (!wasResequenced) {
            return originalList;
        }

        // Read the actual values set by the server and update the records/groups
        const kwargs = { context: this.context };
        const result = await this.model.orm.read(resModel, resIds, [handleField], kwargs);
        for (const dpData of result) {
            const dp = dataPoints.find((d) => this._getDPresId(d) === dpData.id);
            if (dp instanceof Record) {
                dp._applyValues(dpData);
            } else {
                dp[handleField] = dpData[handleField];
            }
        }

        return dataPoints;
    }

    async _toggleArchive(isSelected, state) {
        const method = state ? "action_archive" : "action_unarchive";
        const context = this.context;
        const resIds = await this.getResIds(isSelected);
        const action = await this.model.orm.call(this.resModel, method, [resIds], { context });
        if (
            this.isDomainSelected &&
            resIds.length === this.model.activeIdsLimit &&
            resIds.length < this.count
        ) {
            const msg = sprintf(
                _t("Of the %s records selected, only the first %s have been archived/unarchived."),
                resIds.length,
                this.count
            );
            this.model.notification.add(msg, { title: _t("Warning") });
        }
        const reload = () => this.model.load();
        if (action && Object.keys(action).length) {
            this.model.action.doAction(action, {
                onClose: reload,
            });
        } else {
            return reload();
        }
    }
}
