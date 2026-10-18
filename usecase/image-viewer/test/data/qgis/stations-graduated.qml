<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34.4-Prizren" styleCategories="Symbology|Labeling" hasScaleBasedVisibilityFlag="1" minScale="500000" maxScale="1000" labelsEnabled="1">
  <renderer-v2 type="graduatedSymbol" attr="passengers" graduatedMethod="GraduatedColor" symbollevels="0" forceraster="0" enableorderby="0" referencescale="-1">
    <ranges>
      <range symbol="0" lower="0.000000000000000" upper="1000.000000000000000" label="0 - 1000" render="true" uuid="{a}"/>
      <range symbol="1" lower="1000.000000000000000" upper="5000.000000000000000" label="1000 - 5000" render="true" uuid="{b}"/>
      <range symbol="2" lower="5000.000000000000000" upper="20000.000000000000000" label="5000 - 20000" render="false" uuid="{c}"/>
    </ranges>
    <symbols>
      <symbol type="marker" name="0" alpha="1" clip_to_extent="1" force_rhr="0" frame_rate="10" is_animated="0">
        <data_defined_properties><Option type="Map"><Option name="name" type="QString" value=""/><Option name="properties"/><Option name="type" type="QString" value="collection"/></Option></data_defined_properties>
        <layer class="SimpleMarker" enabled="1" locked="0" pass="0" id="{x}">
          <Option type="Map">
            <Option name="angle" type="QString" value="0"/>
            <Option name="color" type="QString" value="255,245,240,255"/>
            <Option name="name" type="QString" value="triangle"/>
            <Option name="outline_color" type="QString" value="35,35,35,255"/>
            <Option name="outline_style" type="QString" value="solid"/>
            <Option name="outline_width" type="QString" value="0.4"/>
            <Option name="outline_width_unit" type="QString" value="MM"/>
            <Option name="size" type="QString" value="4"/>
            <Option name="size_unit" type="QString" value="MM"/>
          </Option>
        </layer>
      </symbol>
      <symbol type="marker" name="1" alpha="1" clip_to_extent="1" force_rhr="0">
        <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="251,106,74,255"/>
            <Option name="name" type="QString" value="triangle"/>
            <Option name="outline_color" type="QString" value="35,35,35,255"/>
            <Option name="outline_width" type="QString" value="0.4"/>
            <Option name="size" type="QString" value="4"/>
          </Option>
        </layer>
        <layer class="FontMarker" enabled="1" locked="0" pass="0"><Option type="Map"><Option name="chr" type="QString" value="A"/></Option></layer>
      </symbol>
      <symbol type="marker" name="2" alpha="1" clip_to_extent="1" force_rhr="0">
        <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
          <Option type="Map">
            <Option name="color" type="QString" value="103,0,13,255"/>
            <Option name="name" type="QString" value="triangle"/>
            <Option name="size" type="QString" value="4"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
    <classificationMethod id="Quantile"/>
  </renderer-v2>
  <labeling type="simple">
    <settings calloutType="simple">
      <text-style fieldName="name" isExpression="0" fontFamily="Noto Sans JP" fontSize="12" fontSizeUnit="Point" fontWeight="50" textColor="50,50,50,255" textOpacity="1">
        <text-buffer bufferDraw="1" bufferSize="1" bufferSizeUnits="MM" bufferColor="250,250,250,255" bufferOpacity="1"/>
        <shadow shadowDraw="1"/>
      </text-style>
      <placement placement="6" dist="2"/>
      <rendering scaleVisibility="1" scaleMin="0" scaleMax="25000" displayAll="0" obstacle="1"/>
    </settings>
  </labeling>
</qgis>
