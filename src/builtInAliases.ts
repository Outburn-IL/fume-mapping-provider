import { AliasObject } from './types';

export const builtInAliases: AliasObject = {
  exampleMrn: 'http://this.is.an.example.uri/mrn',
  ucum: 'http://unitsofmeasure.org',
  loinc: 'http://loinc.org',
  sct: 'http://snomed.info/sct',
  urn: 'urn:ietf:rfc:3986',
  ssn: 'http://hl7.org/fhir/sid/us-ssn',
  passportPrefix: 'http://hl7.org/fhir/sid/passport-',
  extDar: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
  extLanguage: 'http://hl7.org/fhir/StructureDefinition/language',
  extGeolocation: 'http://hl7.org/fhir/StructureDefinition/geolocation',
  extStreetName: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName',
  extHouseNumber: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-houseNumber',
  extApartment: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-unitID'
};
