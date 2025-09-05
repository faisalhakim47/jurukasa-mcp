import { equal } from 'node:assert/strict';
import { describe, it, suite } from 'node:test';

import { AsciiHierarcy, renderAsciiHierarchy, renderAsciiTable } from '@app/formatter.js';

suite('formatter', function () {

  describe('renderAsciiHierarchy', function () {

    it('should render a simple hierarchy correctly', function () {
      const node: AsciiHierarcy = {
        label: 'Root',
        children: [
          { label: 'Child 1' },
          {
            label: 'Child 2',
            children: [
              { label: 'Grandchild 1' },
              { label: 'Grandchild 2' },
            ],
          },
          { label: 'Child 3' },
        ],
      };

      const expectedOutput =
`Root
├─ Child 1
├─ Child 2
│  ├─ Grandchild 1
│  └─ Grandchild 2
└── Child 3`;

      const result = renderAsciiHierarchy(node, '', true);

      equal(result, expectedOutput);

    });

  });

  describe('renderAsciiTable', function () {

    it('should render a simple table correctly', function () {
      const headers = ['Name', 'Age', 'City'];
      const rows = [
        ['Alice', '25', 'New York'],
        ['Bob', '30', 'Los Angeles'],
        ['Charlie', '35', 'Chicago']
      ];

      const expectedOutput =
`+---------+-----+-------------+
| Name    | Age | City        |
+---------+-----+-------------+
| Alice   | 25  | New York    |
| Bob     | 30  | Los Angeles |
| Charlie | 35  | Chicago     |
+---------+-----+-------------+`;

      const result = renderAsciiTable(headers, rows);

      equal(result, expectedOutput);
    });

    it('should handle empty rows', function () {
      const headers = ['Header1', 'Header2'];
      const rows: string[][] = [];

      const expectedOutput =
`+---------+---------+
| Header1 | Header2 |
+---------+---------+
+---------+---------+`;

      const result = renderAsciiTable(headers, rows);

      equal(result, expectedOutput);
    });

    it('should handle single row', function () {
      const headers = ['Item', 'Price'];
      const rows = [['Apple', '$1.00']];

      const expectedOutput =
`+-------+-------+
| Item  | Price |
+-------+-------+
| Apple | $1.00 |
+-------+-------+`;

      const result = renderAsciiTable(headers, rows);

      equal(result, expectedOutput);
    });

  });

});
