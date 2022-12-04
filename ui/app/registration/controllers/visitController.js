'use strict';

angular.module('bahmni.registration')
    .controller('VisitController', ['$window', '$http', '$cookies', '$scope', '$rootScope', '$state', '$bahmniCookieStore', 'patientService', 'encounterService', '$stateParams', 'spinner', '$timeout', '$q', 'appService', 'openmrsPatientMapper', 'contextChangeHandler', 'messagingService', 'sessionService', 'visitService', '$location', '$translate',
        'auditLogService', 'formService',
        function ($window, $http, $cookies, $scope, $rootScope, $state, $bahmniCookieStore, patientService, encounterService, $stateParams, spinner, $timeout, $q, appService, openmrsPatientMapper, contextChangeHandler, messagingService, sessionService, visitService, $location, $translate, auditLogService, formService) {
            var vm = this;
            var patientUuid = $stateParams.patientUuid;
            var extensions = appService.getAppDescriptor().getExtensions("org.bahmni.registration.conceptSetGroup.observations", "config");
            var formExtensions = appService.getAppDescriptor().getExtensions("org.bahmni.registration.conceptSetGroup.observations", "forms");
            var locationUuid = sessionService.getLoginLocationUuid();
            var selectedProvider = $rootScope.currentProvider;
            var regEncounterTypeUuid = $rootScope.regEncounterConfiguration.encounterTypes[Bahmni.Registration.Constants.registrationEncounterType];
            var visitLocationUuid = $rootScope.visitLocation;

            var getPatient = function () {
                var deferred = $q.defer();
                $window.localStorage.removeItem('refresh');
                patientService.get(patientUuid).then(function (openMRSPatient) {
                    deferred.resolve(openMRSPatient);
                    $scope.patient = openmrsPatientMapper.map(openMRSPatient);
                    $scope.patient.name = openMRSPatient.patient.person.names[0].display;
                    $scope.patient.uuid = openMRSPatient.patient.uuid;
                });
                return deferred.promise;
            };

            var getActiveEncounter = function () {
                var deferred = $q.defer();
                encounterService.find({
                    "patientUuid": patientUuid,
                    "providerUuids": !_.isEmpty($scope.currentProvider.uuid) ? [$scope.currentProvider.uuid] : null,
                    "includeAll": false,
                    locationUuid: locationUuid,
                    encounterTypeUuids: [regEncounterTypeUuid]
                }).then(function (response) {
                    deferred.resolve(response);
                    $scope.encounterUuid = response.data.encounterUuid;
                    $scope.observations = response.data.observations;
                    if ($scope.observations.length > 0) {
                        var visitDetails = [];
                        $scope.observations.forEach(function (value) {
                            if (value.conceptNameToDisplay === "Visit Details") {
                                visitDetails.push(value);
                            }
                        });
                        $scope.admissionFromAccess = visitDetails[0].groupMembers.filter(obs => obs.valueAsString === "IPD Admission");
                    }
                    var getUserRole = function () {
                        var params = {
                            v: "full"
                        };
                        return $http.get('/openmrs/ws/rest/v1/user?limit=500', {
                            method: "GET",
                            params: params,
                            withCredentials: true
                        });
                    };
                    $q.all([getUserRole()]).then(function (response) {
                        var result = response[0].data.results;

                        var providerUuid = $rootScope.currentUser.person.uuid;
                        var filterUser = result.filter(user =>
                            user.person.uuid === providerUuid
                        );
                        var roles = filterUser[0].roles;
                        var verify = roles.filter(role => role.name === "System Developer");
                        if (verify.length > 0) {
                            $scope.reprint = true;
                        } else {
                            $scope.reprint = false;
                        }
                    });
                });
                return deferred.promise;
            };
            var getAllForms = function () {
                var deferred = $q.defer();
                formService.getFormList($scope.encounterUuid)
                    .then(function (response) {
                        $scope.conceptSets = extensions.map(function (extension) {
                            return new Bahmni.ConceptSet.ConceptSetSection(extension, $rootScope.currentUser, {}, [], {});
                        });

                        $scope.observationForms = getObservationForms(formExtensions, response.data);
                        $scope.conceptSets = $scope.conceptSets.concat($scope.observationForms);
                        var value = $cookies.get("bahmni.user.location");
                        if (JSON.parse(value).name === "Emergency") {
                            $scope.opdTicketButton = false;
                            $scope.conceptSets = $scope.conceptSets.filter(data => data.conceptName !== "Room To Assign");
                            var checking = $scope.observations.filter(data => data.formFieldPath === 'Room To Assign Emergency.1/1-0');
                            if (checking.length > 0) {
                                $scope.emergencyTicketButton = true;
                            }
                            else {
                                $scope.emergencyTicketButton = false;
                            }
                        }
                        else {
                            $scope.emergencyTicketButton = false;
                            $scope.conceptSets = $scope.conceptSets.filter(data => data.conceptName !== "Room To Assign Emergency");
                            var checking = $scope.observations.filter(data => data.formFieldPath === 'Room To Assign.2/1-0');
                            if (checking.length > 0) {
                                $scope.opdTicketButton = true;
                            }
                            else {
                                $scope.opdTicketButton = false;
                            }
                        }
                        $scope.availableConceptSets = $scope.conceptSets.filter(function (conceptSet) {
                            return conceptSet.isAvailable($scope.context);
                        });
                        deferred.resolve(response.data);
                    });
                return deferred.promise;
            };

            $scope.hideFields = appService.getAppDescriptor().getConfigValue("hideFields");

            $scope.back = function () {
                $state.go('patient.edit');
            };

            $scope.updatePatientImage = function (image) {
                var updateImagePromise = patientService.updateImage($scope.patient.uuid, image.replace("data:image/jpeg;base64,", ""));
                spinner.forPromise(updateImagePromise);
                return updateImagePromise;
            };

            var save = function () {
                $scope.encounter = {
                    patientUuid: $scope.patient.uuid,
                    locationUuid: locationUuid,
                    encounterTypeUuid: regEncounterTypeUuid,
                    orders: [],
                    drugOrders: [],
                    extensions: {}
                };

                $bahmniCookieStore.put(Bahmni.Common.Constants.grantProviderAccessDataCookieName, selectedProvider, {
                    path: '/',
                    expires: 1
                });

                $scope.encounter.observations = $scope.observations;
                $scope.encounter.observations = new Bahmni.Common.Domain.ObservationFilter().filter($scope.encounter.observations);

                addFormObservations($scope.encounter.observations);

                var createPromise = encounterService.create($scope.encounter);
                spinner.forPromise(createPromise);
                return createPromise.then(function (response) {
                    var messageParams = {
                        encounterUuid: response.data.encounterUuid,
                        encounterType: response.data.encounterType
                    };
                    auditLogService.log(patientUuid, 'EDIT_ENCOUNTER', messageParams, 'MODULE_LABEL_REGISTRATION_KEY');
                    var visitType, visitTypeUuid;
                    visitTypeUuid = response.data.visitTypeUuid;
                    visitService.getVisitType().then(function (response) {
                        visitType = _.find(response.data.results, function (type) {
                            if (type.uuid === visitTypeUuid) {
                                return type;
                            }
                        });
                    });
                });
            };

            var isUserPrivilegedToCloseVisit = function () {
                var applicablePrivs = [Bahmni.Common.Constants.closeVisitPrivilege, Bahmni.Common.Constants.deleteVisitsPrivilege];
                var userPrivs = _.map($rootScope.currentUser.privileges, function (privilege) {
                    return privilege.name;
                });
                return _.some(userPrivs, function (privName) {
                    return _.includes(applicablePrivs, privName);
                });
            };

            var searchActiveVisitsPromise = function () {
                return visitService.search({
                    patient: patientUuid, includeInactive: false, v: "custom:(uuid,location:(uuid))"
                }).then(function (response) {
                    var results = response.data.results;
                    var activeVisitForCurrentLoginLocation;
                    if (results) {
                        activeVisitForCurrentLoginLocation = _.filter(results, function (result) {
                            return result.location.uuid === visitLocationUuid;
                        });
                    }

                    var hasActiveVisit = activeVisitForCurrentLoginLocation.length > 0;
                    vm.visitUuid = hasActiveVisit ? activeVisitForCurrentLoginLocation[0].uuid : "";
                    $scope.canCloseVisit = isUserPrivilegedToCloseVisit() && hasActiveVisit;
                });
            };

            $scope.closeVisitIfDischarged = function () {
                visitService.getVisitSummary(vm.visitUuid).then(function (response) {
                    var visitSummary = response.data;
                    if (visitSummary.admissionDetails && !visitSummary.dischargeDetails) {
                        messagingService.showMessage("error", 'REGISTRATION_VISIT_CANNOT_BE_CLOSED');
                        var messageParams = { visitUuid: vm.visitUuid, visitType: visitSummary.visitType };
                        auditLogService.log(patientUuid, 'CLOSE_VISIT_FAILED', messageParams, 'MODULE_LABEL_REGISTRATION_KEY');
                    } else {
                        closeVisit(visitSummary.visitType);
                    }
                });
            };

            var closeVisit = function (visitType) {
                var confirmed = $window.confirm($translate.instant("REGISTRATION_CONFIRM_CLOSE_VISIT"));
                if (confirmed) {
                    visitService.endVisit(vm.visitUuid).then(function () {
                        $location.url(Bahmni.Registration.Constants.patientSearchURL);
                        var messageParams = { visitUuid: vm.visitUuid, visitType: visitType };
                        auditLogService.log(patientUuid, 'CLOSE_VISIT', messageParams, 'MODULE_LABEL_REGISTRATION_KEY');
                    });
                }
            };

            $scope.getMessage = function () {
                return $scope.message;
            };

            var isObservationFormValid = function () {
                var opdRoomMandatory = appService.getAppDescriptor().getConfigValue("opdRoom");
                var valid = true;
                var isSelectOpd = false;
                var _value = [];
                var value = $cookies.get("bahmni.user.location");
                if (JSON.parse(value).name === "Emergency") {
                    $scope.observationForms = $scope.observationForms.filter(data => data.conceptName !== "Room To Assign");
                }
                else {
                    $scope.observationForms = $scope.observationForms.filter(data => data.conceptName !== "Room To Assign Emergency");
                }
                _.each($scope.observationForms, function (observationForm) {
                    _value = observationForm.component.getValue().observations;
                    if (valid && observationForm.component) {
                        var value = observationForm.component.getValue();
                        if (value.errors) {
                            messagingService.showMessage('error', "{{'REGISTRATION_FORM_ERRORS_MESSAGE_KEY' | translate }}");
                            valid = false;
                        }
                    }
                });
                _.each(_value, function (t) {
                    if (t.concept.name.includes(opdRoomMandatory.conceptName)) {
                        isSelectOpd = true;
                    }
                    if (t.value === undefined) {
                        isSelectOpd = false;
                    }
                });

                if (opdRoomMandatory.isMandatory) {
                    if (!isSelectOpd) {
                        messagingService.showMessage('error', "{{'Please input Opd Consultation Room'}}");
                        valid = false;
                    }
                }

                return valid;
            };

            var validate = function () {
                var isFormValidated = mandatoryValidate();
                var deferred = $q.defer();
                var contxChange = contextChangeHandler.execute();
                var allowContextChange = contxChange["allow"];
                var errorMessage;
                if (!isObservationFormValid()) {
                    deferred.reject("Some fields are not valid");
                    return deferred.promise;
                }
                if (!allowContextChange) {
                    errorMessage = contxChange["errorMessage"] ? contxChange["errorMessage"] : 'REGISTRATION_LABEL_CORRECT_ERRORS';
                    messagingService.showMessage('error', errorMessage);
                    deferred.reject("Some fields are not valid");
                    return deferred.promise;
                } else if (!isFormValidated) { // This ELSE IF condition is to be deleted later.
                    errorMessage = "REGISTRATION_LABEL_ENTER_MANDATORY_FIELDS";
                    messagingService.showMessage('error', errorMessage);
                    deferred.reject("Some fields are not valid");
                    return deferred.promise;
                } else {
                    deferred.resolve();
                    return deferred.promise;
                }
            };

            // Start :: Registration Page validation
            // To be deleted later - Hacky fix only for Registration Page
            var mandatoryConceptGroup = [];
            var mandatoryValidate = function () {
                conceptGroupValidation($scope.observations);
                return isValid(mandatoryConceptGroup);
            };

            var conceptGroupValidation = function (observations) {
                var concepts = _.filter(observations, function (observationNode) {
                    return isMandatoryConcept(observationNode);
                });
                if (!_.isEmpty(concepts)) {
                    mandatoryConceptGroup = _.union(mandatoryConceptGroup, concepts);
                }
            };
            var isMandatoryConcept = function (observation) {
                if (!_.isEmpty(observation.groupMembers)) {
                    conceptGroupValidation(observation.groupMembers);
                } else {
                    return observation.conceptUIConfig && observation.conceptUIConfig.required;
                }
            };
            var isValid = function (mandatoryConcepts) {
                var concept = mandatoryConcepts.filter(function (mandatoryConcept) {
                    if (mandatoryConcept.hasValue()) {
                        return false;
                    }
                    if (mandatoryConcept instanceof Bahmni.ConceptSet.Observation &&
                        mandatoryConcept.conceptUIConfig && mandatoryConcept.conceptUIConfig.multiSelect) {
                        return false;
                    }
                    if (mandatoryConcept.isMultiSelect) {
                        return _.isEmpty(mandatoryConcept.getValues());
                    }
                    return !mandatoryConcept.value;
                });
                return _.isEmpty(concept);
            };
            // End :: Registration Page validation
            var generateQueue = function (queueData) {
                console.log("Queue Generated :: " + queueData);
                return $http({
                    method: 'POST',
                    url: '/openmrs/module/queuemanagement/generate.form',
                    data: JSON.stringify(queueData),
                    headers: {'Content-Type': 'application/json'}
                });
            };

            var afterSave = function () {
                var forwardUrl = appService.getAppDescriptor().getConfigValue("afterVisitSaveForwardUrl");
                var queueManagement = appService.getAppDescriptor().getConfigValue("queueManagement");
                if (forwardUrl != null) {
                    $window.location.href = appService.getAppDescriptor().formatUrl(forwardUrl, { 'patientUuid': patientUuid });
                } else {
                    $state.transitionTo($state.current, $state.params, {
                        reload: true,
                        inherit: false,
                        notify: true
                    });
                }
                messagingService.showMessage('info', 'REGISTRATION_LABEL_SAVED');
                $timeout(function () {
                    $http({
                        method: "GET",
                        url: "/openmrs/ws/rest/v1/bahmnicore/observations?concept=Opd+Consultation+Room&patientUuid=" + patientUuid + "&scope=latest"
                    }).then(function mySuccess (response) {
                        var obsdata = response.data;
                        patientService.get(patientUuid).then(function (openMRSPatient) {
                            $scope.patient = openmrsPatientMapper.map(openMRSPatient);
                            obsdata.forEach(key => {
                                if (key.complexData != null) {
                                    let identifier = $scope.patient.primaryIdentifier.identifier;
                                    let roomName = key.complexData.data.name;
                                    let roomId = key.complexData.data.id;
                                    let date = new Date();
                                    let formatDate = date.toISOString().split("T");
                                    let queue = {
                                        identifier: identifier,
                                        visitroom: roomName,
                                        roomId: roomId,
                                        dateCreated: formatDate[0]
                                    };
                                    if (queueManagement.willUse == true) {
                                        generateQueue(queue);
                                        console.log("Queue Management Started... Queue Submitted :: " + queue);
                                    } else {
                                        console.log("Queue Management Not Started");
                                    }
                                }
                            });
                        });
                    });
                }, 500);
            };

            $scope.submit = function () {
                return validate().then(save).then(afterSave);
            };

            $scope.today = function () {
                return new Date();
            };

            $scope.disableFormSubmitOnEnter = function () {
                $('.visit-patient').find('input').keypress(function (e) {
                    if (e.which === 13) { // Enter key = keycode 13
                        return false;
                    }
                });
            };

            var getConceptSet = function () {
                var visitType = $scope.encounterConfig.getVisitTypeByUuid($scope.visitTypeUuid);
                $scope.context = { visitType: visitType, patient: $scope.patient };
            };

            var getObservationForms = function (extensions, observationsForms) {
                var forms = [];
                var observations = $scope.observations || [];
                _.each(extensions, function (ext) {
                    var options = ext.extensionParams || {};
                    var observationForm = _.find(observationsForms, function (form) {
                        return (form.formName === options.formName || form.name === options.formName);
                    });
                    if (observationForm) {
                        var formUuid = observationForm.formUuid || observationForm.uuid;
                        var formName = observationForm.name || observationForm.formName;
                        var formVersion = observationForm.version || observationForm.formVersion;
                        forms.push(new Bahmni.ObservationForm(formUuid, $rootScope.currentUser, formName, formVersion, observations, ext));
                    }
                });
                return forms;
            };

            var isObjectEmpty = function (obj) {
                return Object.keys(obj).length === 0;
            };

            $scope.allowSave = false;
            $timeout(function () {
                $(".Select-multi-value-wrapper .Select-input input").keypress(function () {
                    let value = [];
                    value = $(this).val().toString();
                    if (isObjectEmpty(value) != true) {
                        $scope.allowSave = true;
                        $timeout();
                    }
                }).keypress();
            }, 1000);

            $scope.isFormTemplate = function (data) {
                return data.formUuid;
            };

            var addFormObservations = function (observations) {
                if ($scope.observationForms) {
                    _.remove(observations, function (observation) {
                        return observation.formNamespace;
                    });
                    _.each($scope.observationForms, function (observationForm) {
                        if (observationForm.component) {
                            var formObservations = observationForm.component.getValue();
                            _.each(formObservations.observations, function (obs) {
                                observations.push(obs);
                            });
                        }
                    });
                }
            };

            spinner.forPromise($q.all([getPatient(), getActiveEncounter(), searchActiveVisitsPromise()])
                .then(function () {
                    getAllForms().then(function () {
                        getConceptSet();
                    });
                }));
        }]);
